import type { Routine, RoutineContext } from "../bot.js";
import {
  ensureDocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  readSettings,
  scavengeWrecks,
  sleep,
  logFactionActivity,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

interface CraftLimit {
  recipeId: string;
  limit: number;
}

function getCrafterSettings(): {
  craftLimits: CraftLimit[];
  refuelThreshold: number;
  repairThreshold: number;
} {
  const all = readSettings();
  const c = all.crafter || {};
  const rawLimits = (c.craftLimits as Record<string, number>) || {};
  const craftLimits: CraftLimit[] = [];
  for (const [recipeId, limit] of Object.entries(rawLimits)) {
    if (limit > 0) {
      craftLimits.push({ recipeId, limit });
    }
  }
  return {
    craftLimits,
    refuelThreshold: (c.refuelThreshold as number) || 50,
    repairThreshold: (c.repairThreshold as number) || 40,
  };
}

// ── Recipe/inventory helpers ─────────────────────────────────

interface Recipe {
  recipe_id: string;
  name: string;
  components: Array<{ item_id: string; name: string; quantity: number }>;
  output_item_id: string;
  output_name: string;
  output_quantity: number;
}

function parseRecipes(data: unknown): Recipe[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;

  let raw: Array<Record<string, unknown>> = [];
  if (Array.isArray(d)) {
    raw = d;
  } else if (Array.isArray(d.items)) {
    raw = d.items as Array<Record<string, unknown>>;
  } else if (Array.isArray(d.recipes)) {
    raw = d.recipes as Array<Record<string, unknown>>;
  } else {
    // Object-keyed recipes
    const values = Object.values(d).filter(v => v && typeof v === "object");
    if (values.length > 0 && Array.isArray(values[0])) {
      // Nested arrays — skip
    } else {
      raw = values as Array<Record<string, unknown>>;
    }
  }

  return raw.map(r => {
    const comps = (r.components || r.ingredients || r.inputs || r.materials || []) as Array<Record<string, unknown>>;

    // outputs may be an array (catalog) or a single object (legacy)
    const rawOutputs = r.outputs || r.output || r.result || r.produces;
    const output: Record<string, unknown> = Array.isArray(rawOutputs)
      ? (rawOutputs[0] as Record<string, unknown>) || {}
      : (rawOutputs as Record<string, unknown>) || {};

    return {
      recipe_id: (r.recipe_id as string) || (r.id as string) || "",
      name: (r.name as string) || (r.recipe_id as string) || "",
      components: comps.map(c => ({
        item_id: (c.item_id as string) || (c.id as string) || (c.item as string) || "",
        name: (c.name as string) || (c.item_name as string) || (c.item_id as string) || (c.id as string) || "",
        quantity: (c.quantity as number) || (c.amount as number) || (c.count as number) || 1,
      })),
      output_item_id: (output.item_id as string) || (output.id as string) || (output.item as string) || (r.output_item_id as string) || "",
      output_name: (output.name as string) || (output.item_name as string) || (r.name as string) || "",
      output_quantity: (output.quantity as number) || (output.amount as number) || (output.count as number) || 1,
    };
  }).filter(r => r.recipe_id);
}

/** Fetch all recipes from the catalog API, handling pagination. */
async function fetchAllRecipes(ctx: RoutineContext): Promise<Recipe[]> {
  const { bot } = ctx;
  const all: Recipe[] = [];
  let page = 1;
  const pageSize = 50;

  while (true) {
    const resp = await bot.exec("catalog", { type: "recipes", page, page_size: pageSize });

    if (resp.error) {
      ctx.log("error", `Catalog fetch failed (page ${page}): ${resp.error.message}`);
      break;
    }

    const r = resp.result as Record<string, unknown> | undefined;
    const totalPages = (r?.total_pages as number) || 1;
    const total = (r?.total as number) || 0;

    if (page === 1) {
      ctx.log("info", `${total} recipes loaded`);
    }

    const parsed = parseRecipes(resp.result);
    all.push(...parsed);

    if (page >= totalPages || parsed.length === 0) break;
    page++;
  }

  return all;
}

/** Count how many of an item exist in cargo + storage + faction storage. */
function countItem(ctx: RoutineContext, itemId: string): number {
  const { bot } = ctx;
  let total = 0;
  for (const i of bot.inventory) {
    if (i.itemId === itemId) total += i.quantity;
  }
  for (const i of bot.storage) {
    if (i.itemId === itemId) total += i.quantity;
  }
  for (const i of bot.factionStorage) {
    if (i.itemId === itemId) total += i.quantity;
  }
  return total;
}

/** Count how many of an item exist in cargo only. */
function countInCargo(ctx: RoutineContext, itemId: string): number {
  let total = 0;
  for (const i of ctx.bot.inventory) {
    if (i.itemId === itemId) total += i.quantity;
  }
  return total;
}

/** Withdraw materials from station storage into cargo for a recipe. */
async function withdrawStorageMaterials(ctx: RoutineContext, recipe: Recipe): Promise<void> {
  const { bot } = ctx;
  for (const comp of recipe.components) {
    const inCargo = countInCargo(ctx, comp.item_id);
    if (inCargo >= comp.quantity) continue;

    const needed = comp.quantity - inCargo;
    const inStorage = bot.storage.find(i => i.itemId === comp.item_id);
    if (!inStorage || inStorage.quantity <= 0) continue;

    const withdrawQty = Math.min(needed, inStorage.quantity);
    const resp = await bot.exec("withdraw_items", { item_id: comp.item_id, quantity: withdrawQty });
    if (!resp.error) {
      ctx.log("craft", `Withdrew ${withdrawQty}x ${comp.name || comp.item_id} from station storage`);
    }
  }
  await bot.refreshCargo();
}

/** Withdraw materials from faction storage into cargo for a recipe. */
async function withdrawFactionMaterials(ctx: RoutineContext, recipe: Recipe): Promise<void> {
  const { bot } = ctx;
  for (const comp of recipe.components) {
    const inCargo = countInCargo(ctx, comp.item_id);
    if (inCargo >= comp.quantity) continue;

    const needed = comp.quantity - inCargo;
    const inFaction = bot.factionStorage.find(i => i.itemId === comp.item_id);
    if (!inFaction || inFaction.quantity <= 0) continue;

    const withdrawQty = Math.min(needed, inFaction.quantity);
    const resp = await bot.exec("faction_withdraw_items", { item_id: comp.item_id, quantity: withdrawQty });
    if (!resp.error) {
      ctx.log("craft", `Withdrew ${withdrawQty}x ${comp.name || comp.item_id} from faction storage`);
      logFactionActivity(ctx, "withdraw", `Withdrew ${withdrawQty}x ${comp.name || comp.item_id} from faction storage`);
    }
  }
  await bot.refreshCargo();
}

/** Check if we have materials in cargo for a recipe. Returns missing item info or null if all present. */
function getMissingMaterial(ctx: RoutineContext, recipe: Recipe): { name: string; need: number; have: number } | null {
  for (const comp of recipe.components) {
    const have = countInCargo(ctx, comp.item_id);
    if (have < comp.quantity) {
      return { name: comp.name || comp.item_id, need: comp.quantity, have };
    }
  }
  return null;
}

/** Check if materials exist anywhere (cargo + storage + faction). */
function hasMaterialsAnywhere(ctx: RoutineContext, recipe: Recipe): boolean {
  for (const comp of recipe.components) {
    if (countItem(ctx, comp.item_id) < comp.quantity) return false;
  }
  return true;
}

/** Build a lookup: output_item_id → Recipe, so we can find what recipe produces a given item. */
function buildRecipeIndex(recipes: Recipe[]): Map<string, Recipe> {
  const index = new Map<string, Recipe>();
  for (const r of recipes) {
    if (r.output_item_id) {
      index.set(r.output_item_id, r);
    }
  }
  return index;
}

/**
 * Attempt to craft prerequisite materials that a recipe needs.
 * For each missing component, check if there's a recipe to produce it,
 * and if raw materials are available, craft it first.
 * Returns list of items crafted (for logging). Max 2 levels of recursion.
 */
async function craftPrerequisites(
  ctx: RoutineContext,
  recipe: Recipe,
  recipeIndex: Map<string, Recipe>,
  depth: number = 0,
): Promise<string[]> {
  if (depth > 2) return []; // prevent infinite recursion
  const { bot } = ctx;
  const crafted: string[] = [];

  for (const comp of recipe.components) {
    const totalAvailable = countItem(ctx, comp.item_id);
    if (totalAvailable >= comp.quantity) continue; // have enough

    const deficit = comp.quantity - totalAvailable;
    const prereqRecipe = recipeIndex.get(comp.item_id);
    if (!prereqRecipe) continue; // no recipe to craft this item

    // How many batches do we need? (each batch produces output_quantity)
    const batchesNeeded = Math.ceil(deficit / (prereqRecipe.output_quantity || 1));

    // Recursively craft sub-prerequisites first
    const subCrafted = await craftPrerequisites(ctx, prereqRecipe, recipeIndex, depth + 1);
    crafted.push(...subCrafted);

    // Refresh inventories after sub-crafting
    await bot.refreshCargo();
    if (bot.docked) {
      await bot.refreshStorage();
      await bot.refreshFactionStorage();
    }

    // Check if we can craft the prerequisite now
    if (!hasMaterialsAnywhere(ctx, prereqRecipe)) continue;

    // Withdraw materials for the prerequisite
    // First deposit any crafted items in cargo to make space
    for (const item of bot.inventory) {
      if (item.quantity <= 0) continue;
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
      // Don't deposit items we need as components for this prereq
      if (prereqRecipe.components.some(c => c.item_id === item.itemId)) continue;
      const dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
      if (dResp.error) {
        await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
      }
    }
    await bot.refreshCargo();

    await withdrawFactionMaterials(ctx, prereqRecipe);
    await withdrawStorageMaterials(ctx, prereqRecipe);

    const stillMissing = getMissingMaterial(ctx, prereqRecipe);
    if (stillMissing) continue; // can't get all materials into cargo

    // Craft the prerequisite
    for (let batch = 0; batch < batchesNeeded && bot.state === "running"; batch++) {
      const craftResp = await bot.exec("craft", { recipe_id: prereqRecipe.recipe_id, count: 1 });
      if (craftResp.error) break;

      const result = craftResp.result as Record<string, unknown> | undefined;
      const qty = (result?.count as number) || (result?.quantity as number) || (prereqRecipe.output_quantity || 1);
      crafted.push(`${qty}x ${prereqRecipe.output_name || prereqRecipe.name}`);
      bot.stats.totalCrafted += qty;

      // Refresh after each craft to update inventory counts
      await bot.refreshCargo();
      if (bot.docked) {
        await bot.refreshStorage();
        await bot.refreshFactionStorage();
      }

      // Re-check if we still need more
      const newTotal = countItem(ctx, comp.item_id);
      if (newTotal >= comp.quantity) break;

      // Check if we still have materials for another batch
      const prereqMissing = getMissingMaterial(ctx, prereqRecipe);
      if (prereqMissing) {
        // Try to withdraw more materials
        await withdrawFactionMaterials(ctx, prereqRecipe);
        await withdrawStorageMaterials(ctx, prereqRecipe);
        if (getMissingMaterial(ctx, prereqRecipe)) break;
      }
    }
  }

  return crafted;
}

/**
 * Grind crafting XP by crafting the simplest recipes we have materials for.
 * Tries up to 5 crafts of the cheapest available recipe to level up skill.
 * Returns list of items crafted for logging.
 */
async function grindCraftingXP(
  ctx: RoutineContext,
  recipes: Recipe[],
  recipeIndex: Map<string, Recipe>,
): Promise<string[]> {
  const { bot } = ctx;
  const crafted: string[] = [];

  // Find recipes we can actually craft right now (have materials, not skill-blocked)
  // Prefer recipes with fewest/cheapest components (basic refining)
  const candidates: Array<{ recipe: Recipe; complexity: number }> = [];

  for (const recipe of recipes) {
    if (!hasMaterialsAnywhere(ctx, recipe)) continue;
    // Complexity = total number of component items needed
    const complexity = recipe.components.reduce((sum, c) => sum + c.quantity, 0);
    candidates.push({ recipe, complexity });
  }

  if (candidates.length === 0) return crafted;

  // Sort by complexity (simplest first — basic refining recipes)
  candidates.sort((a, b) => a.complexity - b.complexity);

  // Try the simplest recipe
  const target = candidates[0].recipe;
  ctx.log("craft", `Grinding XP: crafting ${target.name} (${target.components.map(c => `${c.quantity}x ${c.name}`).join(", ")})...`);

  // Deposit non-essential cargo to make space
  for (const item of bot.inventory) {
    if (item.quantity <= 0) continue;
    const lower = item.itemId.toLowerCase();
    if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
    if (target.components.some(c => c.item_id === item.itemId)) continue;
    const dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
    if (dResp.error) {
      await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
    }
  }
  await bot.refreshCargo();

  const MAX_XP_CRAFTS = 5;
  for (let i = 0; i < MAX_XP_CRAFTS && bot.state === "running"; i++) {
    await bot.refreshCargo();
    if (bot.docked) {
      await bot.refreshStorage();
      await bot.refreshFactionStorage();
    }

    if (!hasMaterialsAnywhere(ctx, target)) break;

    await withdrawFactionMaterials(ctx, target);
    await withdrawStorageMaterials(ctx, target);

    if (getMissingMaterial(ctx, target)) break;

    const craftResp = await bot.exec("craft", { recipe_id: target.recipe_id, count: 1 });
    if (craftResp.error) break;

    const result = craftResp.result as Record<string, unknown> | undefined;
    const qty = (result?.count as number) || (result?.quantity as number) || (target.output_quantity || 1);
    crafted.push(`${qty}x ${target.output_name || target.name}`);
    bot.stats.totalCrafted += qty;
  }

  return crafted;
}

// ── Crafter routine ──────────────────────────────────────────

/**
 * Crafter routine — maintains stock of crafted/refined items:
 *
 * 1. Dock at station
 * 2. Fetch recipes and inventory
 * 3. For each configured recipe with a limit:
 *    - Count current stock (cargo + storage) of output item
 *    - If below limit, craft until limit reached or materials exhausted
 * 4. Refuel, repair
 * 5. Wait, then repeat
 */
export const crafterRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();

  while (bot.state === "running") {
    const settings = getCrafterSettings();

    if (settings.craftLimits.length === 0) {
      ctx.log("info", "No craft limits configured — check Crafter settings. Waiting 30s...");
      await sleep(30000);
      continue;
    }

    // ── Scavenge wrecks before docking ──
    yield "scavenge";
    await scavengeWrecks(ctx);

    // ── Dock at station ──
    yield "dock";
    await bot.refreshStatus();
    await ensureDocked(ctx);

    // ── Fetch recipes via catalog ──
    yield "fetch_recipes";
    const recipes = await fetchAllRecipes(ctx);
    if (recipes.length === 0) {
      ctx.log("error", "No recipes available — waiting 60s");
      await sleep(60000);
      continue;
    }

    // ── Clear cargo space for material withdrawal ──
    await bot.refreshCargo();
    if (bot.docked && bot.inventory.length > 0) {
      for (const item of bot.inventory) {
        if (item.quantity <= 0) continue;
        const lower = item.itemId.toLowerCase();
        if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
        const dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
        if (dResp.error) {
          await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        }
      }
      await bot.refreshCargo();
    }

    // ── Refresh inventory (cargo + personal storage + faction storage) ──
    if (bot.docked) {
      await bot.refreshStorage();
      await bot.refreshFactionStorage();
    }

    // ── Build recipe index for prerequisite lookup ──
    const recipeIndex = buildRecipeIndex(recipes);

    // ── Process each configured limit ──
    let totalCrafted = 0;
    const craftedSummary: string[] = [];   // "5x Fuel Cells"
    const prereqSummary: string[] = [];    // "3x Refined Alloy (prereq)"
    const missingSummary: string[] = [];   // "Armor Plate (2x refined_titanium)"
    const skillSummary: string[] = [];     // "Solarian Composite (skill too low, crafted 5x Refined Iron for XP)"
    const atLimitCount = { count: 0 };

    for (const { recipeId, limit } of settings.craftLimits) {
      if (bot.state !== "running") break;

      const recipe = recipes.find(r =>
        r.recipe_id === recipeId ||
        r.name === recipeId ||
        r.name.toLowerCase() === recipeId.toLowerCase()
      );
      if (!recipe) {
        const similar = recipes
          .filter(r => r.recipe_id.toLowerCase().includes(recipeId.toLowerCase()) || r.name.toLowerCase().includes(recipeId.toLowerCase()))
          .slice(0, 5)
          .map(r => `${r.recipe_id} (${r.name})`);
        ctx.log("error", `Recipe "${recipeId}" not found${similar.length > 0 ? ` — similar: ${similar.join(", ")}` : ""}`);
        continue;
      }

      const outputId = recipe.output_item_id || recipeId;
      const currentStock = countItem(ctx, outputId);
      const needed = limit - currentStock;

      if (needed <= 0) {
        atLimitCount.count++;
        continue;
      }

      // Craft in batches
      let crafted = 0;
      let hitSkillBlock = false;
      while (crafted < needed && bot.state === "running") {
        await bot.refreshCargo();
        if (bot.docked) {
          await bot.refreshStorage();
          await bot.refreshFactionStorage();
        }

        const missing = getMissingMaterial(ctx, recipe);
        if (missing) {
          // Materials not in cargo — try pulling from storage sources
          if (hasMaterialsAnywhere(ctx, recipe)) {
            await withdrawFactionMaterials(ctx, recipe);
            await withdrawStorageMaterials(ctx, recipe);
            const stillMissing = getMissingMaterial(ctx, recipe);
            if (stillMissing) {
              // Try crafting the missing prerequisites
              const preCrafted = await craftPrerequisites(ctx, recipe, recipeIndex);
              if (preCrafted.length > 0) {
                prereqSummary.push(...preCrafted);
                // Refresh and re-withdraw after crafting prereqs
                await bot.refreshCargo();
                if (bot.docked) { await bot.refreshStorage(); await bot.refreshFactionStorage(); }
                await withdrawFactionMaterials(ctx, recipe);
                await withdrawStorageMaterials(ctx, recipe);
              }
              const finalMissing = getMissingMaterial(ctx, recipe);
              if (finalMissing) {
                missingSummary.push(`${recipe.name} (${finalMissing.need}x ${finalMissing.name})`);
                break;
              }
            }
          } else {
            // Materials don't exist anywhere — try crafting prerequisites
            const preCrafted = await craftPrerequisites(ctx, recipe, recipeIndex);
            if (preCrafted.length > 0) {
              prereqSummary.push(...preCrafted);
              await bot.refreshCargo();
              if (bot.docked) { await bot.refreshStorage(); await bot.refreshFactionStorage(); }
              await withdrawFactionMaterials(ctx, recipe);
              await withdrawStorageMaterials(ctx, recipe);
              const finalMissing = getMissingMaterial(ctx, recipe);
              if (finalMissing) {
                missingSummary.push(`${recipe.name} (${finalMissing.need}x ${finalMissing.name})`);
                break;
              }
            } else {
              missingSummary.push(`${recipe.name} (${missing.need}x ${missing.name})`);
              break;
            }
          }
        }

        const remaining = needed - crafted;
        const batchSize = Math.min(remaining, 10);

        yield `craft_${recipeId}`;
        const craftResp = await bot.exec("craft", { recipe_id: recipeId, count: batchSize });

        if (craftResp.error) {
          const msg = craftResp.error.message.toLowerCase();
          if (msg.includes("skill")) {
            hitSkillBlock = true;
          } else if (msg.includes("material") || msg.includes("component") || msg.includes("insufficient")) {
            missingSummary.push(`${recipe.name} (no materials)`);
          } else {
            ctx.log("error", `Craft ${recipe.name}: ${craftResp.error.message}`);
          }
          break;
        }

        const result = craftResp.result as Record<string, unknown> | undefined;
        const actualCount = (result?.count as number) || (result?.quantity as number) || batchSize;
        crafted += actualCount;
        totalCrafted += actualCount;
        bot.stats.totalCrafted += actualCount;
      }

      if (crafted > 0) {
        craftedSummary.push(`${crafted}x ${recipe.name}`);
      }

      // ── Skill too low: try grinding XP on craftable recipes ──
      if (hitSkillBlock && bot.state === "running") {
        const xpCrafted = await grindCraftingXP(ctx, recipes, recipeIndex);
        if (xpCrafted.length > 0) {
          skillSummary.push(`${recipe.name} (skill too low, ground ${xpCrafted.join(", ")} for XP)`);
        } else {
          skillSummary.push(`${recipe.name} (skill too low, no XP recipes available)`);
        }
      }
    }

    // ── Single summary line ──
    const parts: string[] = [];
    if (craftedSummary.length > 0) parts.push(`Crafted ${craftedSummary.join(", ")}`);
    if (prereqSummary.length > 0) parts.push(`Prereqs: ${prereqSummary.join(", ")}`);
    if (atLimitCount.count > 0) parts.push(`${atLimitCount.count} at limit`);
    if (skillSummary.length > 0) parts.push(`Skill: ${skillSummary.join(", ")}`);
    if (missingSummary.length > 0) parts.push(`Missing: ${missingSummary.join(", ")}`);
    if (parts.length > 0) {
      ctx.log("craft", parts.join(". "));
    } else {
      ctx.log("craft", "Nothing to craft");
    }

    // ── Refuel + Repair ──
    yield "refuel";
    await ensureFueled(ctx, settings.refuelThreshold);
    yield "repair";
    await repairShip(ctx);

    // ── Check for skill level-ups ──
    yield "check_skills";
    await bot.checkSkills();

    // ── Wait before next cycle ──
    ctx.log("info", "Waiting 60s before next crafting cycle...");
    await sleep(60000);
  }
};
