import type { Routine, RoutineContext } from "../bot.js";
import {
  ensureDocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  readSettings,
  scavengeWrecks,
  sleep,
  logStatus,
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
    const output = (r.output || r.result || r.produces || {}) as Record<string, unknown>;
    return {
      recipe_id: (r.recipe_id as string) || (r.id as string) || "",
      name: (r.name as string) || (r.recipe_id as string) || "",
      components: comps.map(c => ({
        item_id: (c.item_id as string) || (c.id as string) || "",
        name: (c.name as string) || (c.item_id as string) || "",
        quantity: (c.quantity as number) || 1,
      })),
      output_item_id: (output.item_id as string) || (output.id as string) || (r.output_item_id as string) || "",
      output_name: (output.name as string) || (output.item_name as string) || (r.name as string) || "",
      output_quantity: (output.quantity as number) || 1,
    };
  }).filter(r => r.recipe_id);
}

/** Count how many of an item exist in cargo + storage. */
function countItem(ctx: RoutineContext, itemId: string): number {
  const { bot } = ctx;
  let total = 0;
  for (const i of bot.inventory) {
    if (i.itemId === itemId) total += i.quantity;
  }
  for (const i of bot.storage) {
    if (i.itemId === itemId) total += i.quantity;
  }
  return total;
}

/** Check if we have materials for a recipe (cargo + storage). */
function haveMaterials(ctx: RoutineContext, recipe: Recipe): boolean {
  for (const comp of recipe.components) {
    if (countItem(ctx, comp.item_id) < comp.quantity) return false;
  }
  return true;
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
    logStatus(ctx);
    await ensureDocked(ctx);

    // ── Fetch recipes ──
    yield "get_recipes";
    const recipesResp = await bot.exec("get_recipes");
    const recipes = parseRecipes(recipesResp.result);
    if (recipes.length === 0) {
      ctx.log("error", "No recipes available — waiting 60s");
      await sleep(60000);
      continue;
    }
    ctx.log("info", `${recipes.length} recipes available`);

    // ── Refresh inventory ──
    await bot.refreshCargo();
    if (bot.docked) await bot.refreshStorage();

    // ── Process each configured limit ──
    let totalCrafted = 0;

    for (const { recipeId, limit } of settings.craftLimits) {
      if (bot.state !== "running") break;

      const recipe = recipes.find(r => r.recipe_id === recipeId);
      if (!recipe) {
        ctx.log("error", `Recipe "${recipeId}" not found — skipping`);
        continue;
      }

      const outputId = recipe.output_item_id || recipeId;
      const currentStock = countItem(ctx, outputId);
      const needed = limit - currentStock;

      if (needed <= 0) {
        ctx.log("info", `${recipe.name}: ${currentStock}/${limit} — at limit`);
        continue;
      }

      ctx.log("craft", `${recipe.name}: ${currentStock}/${limit} — need to craft ${needed} more`);

      // Craft in batches
      let crafted = 0;
      while (crafted < needed && bot.state === "running") {
        // Refresh inventory before checking materials
        await bot.refreshCargo();
        if (bot.docked) await bot.refreshStorage();

        if (!haveMaterials(ctx, recipe)) {
          ctx.log("craft", `${recipe.name}: out of materials after crafting ${crafted}`);
          break;
        }

        // Craft up to 10 at a time (API batch limit)
        const remaining = needed - crafted;
        const batchSize = Math.min(remaining, 10);

        yield `craft_${recipeId}`;
        ctx.log("craft", `Crafting ${batchSize}x ${recipe.name}...`);
        const craftResp = await bot.exec("craft", { recipe_id: recipeId, count: batchSize });

        if (craftResp.error) {
          const msg = craftResp.error.message.toLowerCase();
          if (msg.includes("material") || msg.includes("component") || msg.includes("insufficient")) {
            ctx.log("craft", `${recipe.name}: insufficient materials`);
            break;
          }
          if (msg.includes("skill")) {
            ctx.log("craft", `${recipe.name}: insufficient skill level`);
            break;
          }
          ctx.log("error", `Craft failed: ${craftResp.error.message}`);
          break;
        }

        // Parse how many were actually crafted
        const result = craftResp.result as Record<string, unknown> | undefined;
        const actualCount = (result?.count as number) || (result?.quantity as number) || batchSize;
        crafted += actualCount;
        totalCrafted += actualCount;

        ctx.log("craft", `${recipe.name}: crafted ${crafted}/${needed} (total stock: ${currentStock + crafted}/${limit})`);
      }
    }

    if (totalCrafted > 0) {
      ctx.log("info", `=== Crafting cycle complete: ${totalCrafted} items crafted ===`);
    } else {
      ctx.log("info", "=== Crafting cycle complete: nothing to craft ===");
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
