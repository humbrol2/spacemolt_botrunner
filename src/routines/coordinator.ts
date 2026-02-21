import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import {
  ensureDocked,
  tryRefuel,
  repairShip,
  readSettings,
  writeSettings,
  sleep,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

function getCoordinatorSettings(): {
  cycleIntervalSec: number;
  minProfitMargin: number;
  maxCraftLimit: number;
  autoAdjustOre: boolean;
  autoAdjustCraft: boolean;
  targetItems: string[];
} {
  const all = readSettings();
  const c = all.coordinator || {};
  return {
    cycleIntervalSec: (c.cycleIntervalSec as number) || 300,
    minProfitMargin: (c.minProfitMargin as number) || 20,
    maxCraftLimit: (c.maxCraftLimit as number) || 50,
    autoAdjustOre: c.autoAdjustOre !== false,
    autoAdjustCraft: c.autoAdjustCraft !== false,
    targetItems: Array.isArray(c.targetItems) ? (c.targetItems as string[]) : [],
  };
}

// ── Types ────────────────────────────────────────────────────

interface Recipe {
  recipe_id: string;
  name: string;
  components: Array<{ item_id: string; name: string; quantity: number }>;
  output_item_id: string;
  output_name: string;
  output_quantity: number;
}

interface DemandEntry {
  totalValue: number;
  bestPrice: number;
  stations: string[];
}

// ── Recipe parsing ───────────────────────────────────────────

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
    const values = Object.values(d).filter(v => v && typeof v === "object");
    if (values.length > 0 && !Array.isArray(values[0])) {
      raw = values as Array<Record<string, unknown>>;
    }
  }

  return raw.map(r => {
    const comps = (r.components || r.ingredients || r.inputs || r.materials || []) as Array<Record<string, unknown>>;
    const rawOutputs = r.outputs || r.output || r.result || r.produces;
    const output: Record<string, unknown> = Array.isArray(rawOutputs)
      ? (rawOutputs[0] as Record<string, unknown>) || {}
      : (rawOutputs as Record<string, unknown>) || {};

    return {
      recipe_id: (r.recipe_id as string) || (r.id as string) || "",
      name: (r.name as string) || (r.recipe_id as string) || "",
      components: comps.map(c => ({
        item_id: (c.item_id as string) || (c.id as string) || (c.item as string) || "",
        name: (c.name as string) || (c.item_name as string) || (c.item_id as string) || "",
        quantity: (c.quantity as number) || (c.amount as number) || (c.count as number) || 1,
      })),
      output_item_id: (output.item_id as string) || (output.id as string) || (r.output_item_id as string) || "",
      output_name: (output.name as string) || (output.item_name as string) || (r.name as string) || "",
      output_quantity: (output.quantity as number) || (output.amount as number) || 1,
    };
  }).filter(r => r.recipe_id);
}

/** Fetch all recipes from the catalog API, handling pagination. */
async function fetchAllRecipes(ctx: RoutineContext): Promise<Recipe[]> {
  const { bot } = ctx;
  const all: Recipe[] = [];
  let page = 1;

  while (true) {
    const resp = await bot.exec("catalog", { type: "recipes", page, page_size: 50 });
    if (resp.error) {
      ctx.log("error", `Catalog fetch failed (page ${page}): ${resp.error.message}`);
      break;
    }

    const r = resp.result as Record<string, unknown> | undefined;
    const totalPages = (r?.total_pages as number) || 1;
    const parsed = parseRecipes(resp.result);
    all.push(...parsed);

    if (page >= totalPages || parsed.length === 0) break;
    page++;
  }

  return all;
}

// ── Demand analysis helpers ──────────────────────────────────

/** Build a map of items with buy orders across all known markets. */
function buildDemandMap(): Map<string, DemandEntry> {
  const demand = new Map<string, DemandEntry>();
  const allBuys = mapStore.getAllBuyDemand();

  for (const buy of allBuys) {
    const existing = demand.get(buy.itemId);
    const value = buy.price * buy.quantity;
    if (existing) {
      existing.totalValue += value;
      if (buy.price > existing.bestPrice) existing.bestPrice = buy.price;
      if (!existing.stations.includes(buy.poiName)) existing.stations.push(buy.poiName);
    } else {
      demand.set(buy.itemId, {
        totalValue: value,
        bestPrice: buy.price,
        stations: [buy.poiName],
      });
    }
  }

  return demand;
}

/** Calculate profit margin for crafting a recipe and selling at the demand price. */
function calculateCraftProfit(recipe: Recipe, demandPrice: number): { profitPct: number; materialCost: number } {
  let materialCost = 0;

  for (const comp of recipe.components) {
    const bestSell = mapStore.findBestSellPrice(comp.item_id);
    if (!bestSell) {
      // Unknown material cost — can't estimate profitability
      return { profitPct: -1, materialCost: -1 };
    }
    materialCost += bestSell.price * comp.quantity;
  }

  if (materialCost <= 0) return { profitPct: -1, materialCost: 0 };

  const revenue = demandPrice * recipe.output_quantity;
  const profitPct = ((revenue - materialCost) / materialCost) * 100;
  return { profitPct, materialCost };
}

/** Find which ore is most consumed by the active craft limits. */
function findMostNeededOre(
  recipes: Recipe[],
  craftLimits: Record<string, number>,
): string {
  const oreConsumption = new Map<string, number>();

  for (const [recipeId, limit] of Object.entries(craftLimits)) {
    if (limit <= 0) continue;
    const recipe = recipes.find(r => r.recipe_id === recipeId || r.name === recipeId);
    if (!recipe) continue;

    for (const comp of recipe.components) {
      // Check if this component is a raw ore (exists in mapStore ore data)
      const oreLocations = mapStore.findOreLocations(comp.item_id);
      if (oreLocations.length > 0) {
        oreConsumption.set(
          comp.item_id,
          (oreConsumption.get(comp.item_id) || 0) + comp.quantity * limit,
        );
      }
    }
  }

  let bestOre = "";
  let bestConsumption = 0;
  for (const [oreId, consumption] of oreConsumption) {
    if (consumption > bestConsumption) {
      bestConsumption = consumption;
      bestOre = oreId;
    }
  }

  return bestOre;
}

// ── Coordinator routine ──────────────────────────────────────

/**
 * Coordinator routine — stays docked, analyzes market demand, and auto-adjusts
 * crafter craftLimits and miner targetOre in settings.json.
 *
 * 1. Scan mapStore for all market data across known stations
 * 2. Build demand map: items with buy orders
 * 3. Fetch recipe catalog
 * 4. For each in-demand item that can be crafted, calculate profitability
 * 5. Update crafter craftLimits for profitable recipes
 * 6. Update miner targetOre for most-needed raw material
 * 7. Sleep, repeat
 */
export const coordinatorRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();

  while (bot.state === "running") {
    const settings = getCoordinatorSettings();

    // ── Ensure docked ──
    yield "dock";
    await ensureDocked(ctx);

    // ── Refresh market data at current station ──
    yield "refresh_market";
    if (bot.docked) {
      const marketResp = await bot.exec("view_market");
      if (marketResp.result && typeof marketResp.result === "object" && bot.system && bot.poi) {
        mapStore.updateMarket(bot.system, bot.poi, marketResp.result as Record<string, unknown>);
      }
    }

    // ── Build demand map ──
    yield "analyze_demand";
    const demandMap = buildDemandMap();

    if (demandMap.size === 0) {
      ctx.log("coord", "No buy demand found on any known market — waiting for explorer/market data");
      await sleep(settings.cycleIntervalSec * 1000);
      continue;
    }

    ctx.log("coord", `Found demand for ${demandMap.size} item(s) across known markets`);

    // ── Fetch recipes ──
    yield "fetch_recipes";
    const recipes = await fetchAllRecipes(ctx);
    if (recipes.length === 0) {
      ctx.log("error", "No recipes available — waiting for next cycle");
      await sleep(settings.cycleIntervalSec * 1000);
      continue;
    }
    ctx.log("coord", `Loaded ${recipes.length} recipes`);

    // ── Analyze profitability ──
    yield "calculate_profit";
    const profitable: Array<{ recipe: Recipe; profitPct: number; demandPrice: number }> = [];

    for (const recipe of recipes) {
      const outputId = recipe.output_item_id || recipe.recipe_id;
      const demand = demandMap.get(outputId);
      if (!demand) continue;

      // Filter by targetItems if configured
      if (settings.targetItems.length > 0) {
        const match = settings.targetItems.some(t =>
          outputId.toLowerCase().includes(t.toLowerCase()) ||
          recipe.name.toLowerCase().includes(t.toLowerCase())
        );
        if (!match) continue;
      }

      const { profitPct } = calculateCraftProfit(recipe, demand.bestPrice);
      if (profitPct >= settings.minProfitMargin) {
        profitable.push({ recipe, profitPct, demandPrice: demand.bestPrice });
      }
    }

    // Sort by profit descending
    profitable.sort((a, b) => b.profitPct - a.profitPct);

    // ── Update crafter settings ──
    if (settings.autoAdjustCraft && profitable.length > 0) {
      yield "update_craft_limits";
      const allSettings = readSettings();
      const crafterSettings = allSettings.crafter || {};
      const currentLimits = (crafterSettings.craftLimits as Record<string, number>) || {};
      const newLimits: Record<string, number> = { ...currentLimits };

      const adjustments: string[] = [];
      for (const { recipe, profitPct } of profitable) {
        const recipeId = recipe.recipe_id;
        // Scale limit by profit margin — higher profit = higher limit
        const scaledLimit = Math.min(
          settings.maxCraftLimit,
          Math.max(5, Math.round(profitPct / 10) * 5),
        );

        const prev = newLimits[recipeId] || 0;
        if (scaledLimit > prev) {
          newLimits[recipeId] = scaledLimit;
          adjustments.push(`${recipe.name}: ${prev} → ${scaledLimit} (${Math.round(profitPct)}% margin)`);
        }
      }

      if (adjustments.length > 0) {
        writeSettings({ crafter: { craftLimits: newLimits } });
        ctx.log("coord", `Adjusted craft limits: ${adjustments.join(", ")}`);
      } else {
        ctx.log("coord", "Craft limits already optimal — no changes");
      }
    } else if (settings.autoAdjustCraft) {
      ctx.log("coord", "No profitable crafting opportunities found");
    }

    // ── Update miner targetOre ──
    if (settings.autoAdjustOre) {
      yield "update_ore_target";
      const allSettings = readSettings();
      const crafterLimits = ((allSettings.crafter || {}).craftLimits as Record<string, number>) || {};
      const bestOre = findMostNeededOre(recipes, crafterLimits);

      if (bestOre) {
        const currentOre = ((allSettings.miner || {}).targetOre as string) || "";
        if (bestOre !== currentOre) {
          writeSettings({ miner: { targetOre: bestOre } });
          ctx.log("coord", `Miner target ore: ${currentOre || "(none)"} → ${bestOre}`);
        } else {
          ctx.log("coord", `Miner target ore unchanged: ${bestOre}`);
        }
      }
    }

    // ── Summary ──
    const demandSummary = [...demandMap.entries()]
      .sort((a, b) => b[1].totalValue - a[1].totalValue)
      .slice(0, 5)
      .map(([id, d]) => `${id} (${d.bestPrice}cr × ${Math.round(d.totalValue / d.bestPrice)} qty)`)
      .join(", ");
    ctx.log("coord", `Top demand: ${demandSummary}`);

    // ── Maintenance ──
    yield "maintenance";
    await tryRefuel(ctx);
    await repairShip(ctx);

    // ── Wait for next cycle ──
    ctx.log("info", `Next analysis in ${settings.cycleIntervalSec}s...`);
    await sleep(settings.cycleIntervalSec * 1000);
  }
};
