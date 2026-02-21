import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import {
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  collectFromStorage,
  recordMarketData,
  getSystemInfo,
  findStation,
  readSettings,
  sleep,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

function getTraderSettings(): {
  minProfitPerUnit: number;
  maxCargoValue: number;
  fuelCostPerJump: number;
  refuelThreshold: number;
  repairThreshold: number;
  homeSystem: string;
  tradeItems: string[];
} {
  const all = readSettings();
  const t = all.trader || {};
  return {
    minProfitPerUnit: (t.minProfitPerUnit as number) || 10,
    maxCargoValue: (t.maxCargoValue as number) || 0,
    fuelCostPerJump: (t.fuelCostPerJump as number) || 50,
    refuelThreshold: (t.refuelThreshold as number) || 50,
    repairThreshold: (t.repairThreshold as number) || 40,
    homeSystem: (t.homeSystem as string) || "",
    tradeItems: Array.isArray(t.tradeItems) ? (t.tradeItems as string[]) : [],
  };
}

// ── Types ────────────────────────────────────────────────────

interface TradeRoute {
  itemId: string;
  itemName: string;
  sourceSystem: string;
  sourcePoi: string;
  sourcePoiName: string;
  buyPrice: number;
  buyQty: number;
  destSystem: string;
  destPoi: string;
  destPoiName: string;
  sellPrice: number;
  sellQty: number;
  jumps: number;
  profitPerUnit: number;
  totalProfit: number;
}

// ── Trade route discovery ────────────────────────────────────

/** Estimate fuel cost between two systems using mapStore route data. */
function estimateFuelCost(fromSystem: string, toSystem: string, costPerJump: number): { jumps: number; cost: number } {
  if (fromSystem === toSystem) return { jumps: 0, cost: 0 };
  const route = mapStore.findRoute(fromSystem, toSystem);
  if (!route) return { jumps: 999, cost: 999 * costPerJump };
  const jumps = route.length - 1;
  return { jumps, cost: jumps * costPerJump };
}

/** Find profitable trade routes from mapStore price spreads. */
function findTradeOpportunities(settings: ReturnType<typeof getTraderSettings>, currentSystem: string): TradeRoute[] {
  const spreads = mapStore.findPriceSpreads();
  const routes: TradeRoute[] = [];

  for (const sp of spreads) {
    // Filter by allowed items
    if (settings.tradeItems.length > 0) {
      const match = settings.tradeItems.some(t =>
        sp.itemId.toLowerCase().includes(t.toLowerCase()) ||
        sp.itemName.toLowerCase().includes(t.toLowerCase())
      );
      if (!match) continue;
    }

    // Calculate route: current → source → dest
    const toSource = estimateFuelCost(currentSystem, sp.sourceSystem, settings.fuelCostPerJump);
    const sourceToDest = estimateFuelCost(sp.sourceSystem, sp.destSystem, settings.fuelCostPerJump);
    const totalJumps = toSource.jumps + sourceToDest.jumps;
    const totalFuelCost = toSource.cost + sourceToDest.cost;

    const profitPerUnit = sp.spread - (totalJumps > 0 ? totalFuelCost / Math.min(sp.buyQty, sp.sellQty) : 0);
    if (profitPerUnit < settings.minProfitPerUnit) continue;

    const tradeQty = Math.min(sp.buyQty, sp.sellQty);
    const totalProfit = profitPerUnit * tradeQty;

    // Cap by max cargo value
    if (settings.maxCargoValue > 0 && sp.buyAt * tradeQty > settings.maxCargoValue) continue;

    routes.push({
      itemId: sp.itemId,
      itemName: sp.itemName,
      sourceSystem: sp.sourceSystem,
      sourcePoi: sp.sourcePoi,
      sourcePoiName: sp.sourcePoiName,
      buyPrice: sp.buyAt,
      buyQty: tradeQty,
      destSystem: sp.destSystem,
      destPoi: sp.destPoi,
      destPoiName: sp.destPoiName,
      sellPrice: sp.sellAt,
      sellQty: tradeQty,
      jumps: totalJumps,
      profitPerUnit,
      totalProfit,
    });
  }

  // Sort by total profit descending
  routes.sort((a, b) => b.totalProfit - a.totalProfit);
  return routes;
}

// ── Trader routine ───────────────────────────────────────────

/**
 * Trader routine — travels between stations, buys items cheaply, sells at higher prices:
 *
 * 1. Dock at current station, refresh market data
 * 2. Scan mapStore for price spreads across known stations
 * 3. Pick best trade opportunity (highest total profit)
 * 4. Travel to source station, buy items
 * 5. Travel to destination station, sell items
 * 6. Refuel, repair, repeat
 */
export const traderRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();

  while (bot.state === "running") {
    const settings = getTraderSettings();
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };

    // ── Ensure docked, collect storage, record market ──
    yield "dock";
    await ensureDocked(ctx);
    if (bot.docked) {
      await recordMarketData(ctx);
    }

    // ── Fuel + hull check ──
    yield "maintenance";
    await tryRefuel(ctx);
    await repairShip(ctx);

    // ── Find trade opportunities ──
    yield "find_trades";
    await bot.refreshStatus();
    const routes = findTradeOpportunities(settings, bot.system);

    if (routes.length === 0) {
      ctx.log("trade", "No profitable trade routes found — waiting 60s before re-scanning");
      await sleep(60000);
      continue;
    }

    const route = routes[0];
    ctx.log("trade", `Best route: ${route.itemName} — buy ${route.buyQty}x at ${route.sourcePoiName} (${route.buyPrice}cr) → sell at ${route.destPoiName} (${route.sellPrice}cr) — est. profit ${Math.round(route.totalProfit)}cr (${route.jumps} jumps)`);

    // ── Phase 1: Travel to source station and buy ──
    yield "travel_to_source";

    // Navigate to source system if needed
    if (bot.system !== route.sourceSystem) {
      await ensureUndocked(ctx);
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!fueled) {
        ctx.log("error", "Cannot refuel for trade run — waiting 30s");
        await sleep(30000);
        continue;
      }

      ctx.log("travel", `Heading to ${route.sourcePoiName} in ${route.sourceSystem}...`);
      const arrived = await navigateToSystem(ctx, route.sourceSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to reach source system — trying next route");
        continue;
      }
    }

    // Travel to source POI and dock
    await ensureUndocked(ctx);
    if (bot.poi !== route.sourcePoi) {
      ctx.log("travel", `Traveling to ${route.sourcePoiName}...`);
      const tResp = await bot.exec("travel", { target_poi: route.sourcePoi });
      if (tResp.error && !tResp.error.message.includes("already")) {
        ctx.log("error", `Travel to source failed: ${tResp.error.message}`);
        continue;
      }
      bot.poi = route.sourcePoi;
    }

    // Dock at source
    yield "dock_source";
    const dResp = await bot.exec("dock");
    if (dResp.error && !dResp.error.message.includes("already")) {
      ctx.log("error", `Dock failed at source: ${dResp.error.message}`);
      continue;
    }
    bot.docked = true;

    // Withdraw only credits from storage (don't pull items — we need cargo space for trade goods)
    const storageResp = await bot.exec("view_storage");
    if (storageResp.result && typeof storageResp.result === "object") {
      const sr = storageResp.result as Record<string, unknown>;
      const storedCredits = (sr.credits as number) || (sr.stored_credits as number) || 0;
      if (storedCredits > 0) {
        await bot.exec("withdraw_credits", { amount: storedCredits });
        ctx.log("trade", `Withdrew ${storedCredits} credits from storage`);
      }
    }

    // Record fresh market data at source
    await recordMarketData(ctx);

    // Clear cargo: keep 3 fuel cells, deposit everything else to storage
    const RESERVE_FUEL_CELLS = 3;
    await bot.refreshCargo();
    const depositSummary: string[] = [];
    for (const item of bot.inventory) {
      const lower = item.itemId.toLowerCase();
      const isFuel = lower.includes("fuel") || lower.includes("energy_cell");
      if (isFuel) {
        const excess = item.quantity - RESERVE_FUEL_CELLS;
        if (excess > 0) {
          await bot.exec("deposit_items", { item_id: item.itemId, quantity: excess });
          depositSummary.push(`${excess}x ${item.name}`);
        }
      } else {
        await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        depositSummary.push(`${item.quantity}x ${item.name}`);
      }
    }
    if (depositSummary.length > 0) {
      ctx.log("trade", `Cleared cargo: ${depositSummary.join(", ")}`);
    }

    // Ensure we have at least RESERVE_FUEL_CELLS fuel cells (buy if needed)
    await bot.refreshCargo();
    let fuelInCargo = 0;
    for (const item of bot.inventory) {
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) fuelInCargo += item.quantity;
    }
    if (fuelInCargo < RESERVE_FUEL_CELLS) {
      const needed = RESERVE_FUEL_CELLS - fuelInCargo;
      ctx.log("trade", `Buying ${needed} fuel cells for emergency reserve...`);
      await bot.exec("buy", { item_id: "fuel_cell", quantity: needed });
    }

    // Determine how much we can buy (limited by cargo space and available credits)
    await bot.refreshStatus();
    const freeSpace = bot.cargoMax > 0 ? bot.cargoMax - bot.cargo : 999;
    let buyQty = Math.min(route.buyQty, freeSpace);
    if (settings.maxCargoValue > 0) {
      const maxByValue = Math.floor(settings.maxCargoValue / route.buyPrice);
      buyQty = Math.min(buyQty, maxByValue);
    }
    const maxByCredits = Math.floor(bot.credits / route.buyPrice);
    buyQty = Math.min(buyQty, maxByCredits);

    if (buyQty <= 0) {
      ctx.log("trade", "Cannot afford any items or cargo full — skipping route");
      continue;
    }

    // Buy items
    yield "buy";
    ctx.log("trade", `Buying ${buyQty}x ${route.itemName} at ${route.buyPrice}cr/ea...`);
    const buyResp = await bot.exec("buy", { item_id: route.itemId, quantity: buyQty });
    if (buyResp.error) {
      ctx.log("error", `Buy failed: ${buyResp.error.message}`);
      // Try with a smaller quantity
      if (buyQty > 1) {
        const halfQty = Math.floor(buyQty / 2);
        ctx.log("trade", `Retrying with ${halfQty}x...`);
        const retryResp = await bot.exec("buy", { item_id: route.itemId, quantity: halfQty });
        if (retryResp.error) {
          ctx.log("error", `Retry failed: ${retryResp.error.message} — skipping route`);
          continue;
        }
        buyQty = halfQty;
      } else {
        continue;
      }
    }

    await bot.refreshStatus();
    const investedCredits = buyQty * route.buyPrice;
    ctx.log("trade", `Purchased ${buyQty}x ${route.itemName} for ${investedCredits}cr`);

    // ── Phase 2: Travel to destination and sell ──
    yield "travel_to_dest";
    await ensureUndocked(ctx);

    // Ensure fuel for the trip
    const fueled2 = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
    if (!fueled2) {
      ctx.log("error", "Cannot refuel for delivery — selling locally instead");
      await ensureDocked(ctx);
      await bot.exec("sell", { item_id: route.itemId, quantity: buyQty });
      await bot.refreshStatus();
      continue;
    }

    if (bot.system !== route.destSystem) {
      ctx.log("travel", `Heading to ${route.destPoiName} in ${route.destSystem}...`);
      const arrived2 = await navigateToSystem(ctx, route.destSystem, safetyOpts);
      if (!arrived2) {
        ctx.log("error", "Failed to reach destination — selling at nearest station");
        await ensureDocked(ctx);
        await bot.exec("sell", { item_id: route.itemId, quantity: buyQty });
        await bot.refreshStatus();
        continue;
      }
    }

    // Travel to destination POI
    await ensureUndocked(ctx);
    if (bot.poi !== route.destPoi) {
      ctx.log("travel", `Traveling to ${route.destPoiName}...`);
      const t2Resp = await bot.exec("travel", { target_poi: route.destPoi });
      if (t2Resp.error && !t2Resp.error.message.includes("already")) {
        ctx.log("error", `Travel to dest failed: ${t2Resp.error.message}`);
        // Try to sell wherever we are
        const { pois } = await getSystemInfo(ctx);
        const station = findStation(pois);
        if (station) {
          await bot.exec("travel", { target_poi: station.id });
          bot.poi = station.id;
        }
      } else {
        bot.poi = route.destPoi;
      }
    }

    // Dock at destination
    yield "dock_dest";
    const d2Resp = await bot.exec("dock");
    if (d2Resp.error && !d2Resp.error.message.includes("already")) {
      ctx.log("error", `Dock failed at dest: ${d2Resp.error.message}`);
      continue;
    }
    bot.docked = true;
    await collectFromStorage(ctx);

    // Sell items
    yield "sell";
    const creditsBefore = bot.credits;
    ctx.log("trade", `Selling ${buyQty}x ${route.itemName} at ${route.sellPrice}cr/ea...`);
    const sellResp = await bot.exec("sell", { item_id: route.itemId, quantity: buyQty });
    if (sellResp.error) {
      ctx.log("error", `Sell failed: ${sellResp.error.message}`);
      // Try selling all of this item from cargo
      await bot.refreshCargo();
      const inCargo = bot.inventory.find(i => i.itemId === route.itemId);
      if (inCargo && inCargo.quantity > 0) {
        await bot.exec("sell", { item_id: route.itemId, quantity: inCargo.quantity });
      }
    }

    await bot.refreshStatus();
    const creditsAfter = bot.credits;
    const actualProfit = creditsAfter - creditsBefore + investedCredits;

    // Record market data at destination
    await recordMarketData(ctx);

    // ── Trade summary ──
    ctx.log("trade", `Trade run complete: ${buyQty}x ${route.itemName} — bought at ${route.sourcePoiName} (${route.buyPrice}cr/ea), sold at ${route.destPoiName} (${route.sellPrice}cr/ea) — profit ${actualProfit}cr (${route.jumps} jumps)`);

    // ── Maintenance ──
    yield "post_trade_maintenance";
    await tryRefuel(ctx);
    await repairShip(ctx);

    // ── Check skills ──
    yield "check_skills";
    await bot.checkSkills();

    await bot.refreshStatus();
    const endFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Credits: ${bot.credits} | Fuel: ${endFuel}% | Cargo: ${bot.cargo}/${bot.cargoMax}`);
  }
};
