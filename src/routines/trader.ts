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
  factionDonateProfit,
  readSettings,
  sleep,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

function getTraderSettings(username?: string): {
  minProfitPerUnit: number;
  maxCargoValue: number;
  fuelCostPerJump: number;
  refuelThreshold: number;
  repairThreshold: number;
  homeSystem: string;
  tradeItems: string[];
  autoInsure: boolean;
} {
  const all = readSettings();
  const t = all.trader || {};
  const botOverrides = username ? (all[username] || {}) : {};
  return {
    minProfitPerUnit: (t.minProfitPerUnit as number) || 10,
    maxCargoValue: (t.maxCargoValue as number) || 0,
    fuelCostPerJump: (t.fuelCostPerJump as number) || 50,
    refuelThreshold: (t.refuelThreshold as number) || 50,
    repairThreshold: (t.repairThreshold as number) || 40,
    homeSystem: (botOverrides.homeSystem as string) || (t.homeSystem as string) || "",
    tradeItems: Array.isArray(t.tradeItems) ? (t.tradeItems as string[]) : [],
    autoInsure: (t.autoInsure as boolean) !== false,
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

/** Find the cheapest known market sell price for an item (replacement/acquisition cost). */
function getItemMarketCost(itemId: string): number {
  let cheapest = Infinity;
  const systems = mapStore.getAllSystems();
  for (const sys of Object.values(systems)) {
    for (const poi of sys.pois) {
      for (const m of poi.market) {
        if (m.item_id === itemId && m.best_sell !== null && m.best_sell > 0) {
          if (m.best_sell < cheapest) cheapest = m.best_sell;
        }
      }
    }
  }
  return cheapest === Infinity ? 0 : cheapest;
}

/**
 * Find profitable routes for items already in faction storage.
 * Uses the cheapest known market price as cost basis — profit is
 * sellPrice - materialCost - fuelCost. The trader withdraws from
 * faction storage at its current station, then travels to sell.
 */
function findFactionStorageRoutes(
  ctx: RoutineContext,
  settings: ReturnType<typeof getTraderSettings>,
  currentSystem: string,
): TradeRoute[] {
  const { bot } = ctx;
  const routes: TradeRoute[] = [];
  if (bot.factionStorage.length === 0) return routes;

  const allBuys = mapStore.getAllBuyDemand();
  if (allBuys.length === 0) return routes;

  for (const item of bot.factionStorage) {
    const lower = item.itemId.toLowerCase();
    if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
    if (item.quantity <= 0) continue;

    // Filter by allowed items if configured
    if (settings.tradeItems.length > 0) {
      const match = settings.tradeItems.some(t =>
        item.itemId.toLowerCase().includes(t.toLowerCase()) ||
        item.name.toLowerCase().includes(t.toLowerCase())
      );
      if (!match) continue;
    }

    // Material cost = cheapest known market price for this item
    const itemCost = getItemMarketCost(item.itemId);

    // Find best buy order for this item across all known stations
    const itemBuys = allBuys
      .filter(b => b.itemId === item.itemId && b.price > 0)
      .sort((a, b) => b.price - a.price);

    for (const buy of itemBuys) {
      // Skip if sell price doesn't beat material cost
      if (buy.price <= itemCost) continue;

      const { jumps, cost: fuelCost } = estimateFuelCost(currentSystem, buy.systemId, settings.fuelCostPerJump);
      if (jumps >= 999) continue;

      const sellQty = Math.min(item.quantity, buy.quantity);
      const profitPerUnit = buy.price - itemCost - (jumps > 0 ? fuelCost / sellQty : 0);
      if (profitPerUnit < settings.minProfitPerUnit) continue;

      const totalProfit = profitPerUnit * sellQty;

      routes.push({
        itemId: item.itemId,
        itemName: item.name,
        sourceSystem: currentSystem,
        sourcePoi: "",       // signals: withdraw from faction storage
        sourcePoiName: "faction storage",
        buyPrice: itemCost,  // material/market cost basis
        buyQty: sellQty,
        destSystem: buy.systemId,
        destPoi: buy.poiId,
        destPoiName: buy.poiName,
        sellPrice: buy.price,
        sellQty,
        jumps,
        profitPerUnit,
        totalProfit,
      });
      break; // best buy order for this item found
    }
  }

  routes.sort((a, b) => b.totalProfit - a.totalProfit);
  return routes;
}

// ── Market analysis ──────────────────────────────────────────

/** Call analyze_market and log top insight. Builds trading XP. Must be docked. */
async function analyzeMarket(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  const resp = await bot.exec("analyze_market", { mode: "overview" });
  if (!resp.error && resp.result && typeof resp.result === "object") {
    const r = resp.result as Record<string, unknown>;
    const insights = r.top_insights as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(insights) && insights.length > 0) {
      const top = insights[0];
      ctx.log("trade", `Market intel: ${(top.message as string) ?? (top.category as string) ?? "no insights"}`);
    }
  }
}

// ── Insurance ────────────────────────────────────────────────

/**
 * Buy ship insurance if not already covered and cargo value justifies it.
 * Should be called while docked at source, after loading trade goods.
 */
async function tryInsureShip(ctx: RoutineContext, cargoValue: number): Promise<void> {
  const { bot } = ctx;

  if (cargoValue <= 0) return;

  // Get a quote — also tells us if we already have coverage
  const quoteResp = await bot.exec("get_insurance_quote");
  if (quoteResp.error || !quoteResp.result) return;

  const qr = quoteResp.result as Record<string, unknown>;
  const quoteObj = (qr.quote as Record<string, unknown>) ?? qr;
  const premium = (quoteObj.premium as number) ?? 0;

  // Already insured?
  const insured = (quoteObj.insured as boolean) ?? (qr.insured as boolean) ?? false;
  if (insured) return;

  // Only insure if we can comfortably afford it
  if (!premium || premium > cargoValue * 0.1 || bot.credits < premium * 3) return;

  const insureResp = await bot.exec("buy_insurance");
  if (!insureResp.error) {
    ctx.log("trade", `Insured ship for trade run (premium: ${premium}cr, cargo value: ~${cargoValue}cr)`);
    await bot.refreshStatus();
  }
}

// ── Missions ─────────────────────────────────────────────────

/**
 * Complete any active missions that are ready, then accept new market/trade
 * missions at the current station (up to 2 per visit, respecting the 5-mission cap).
 * Must be docked.
 */
async function tryMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  // Try to complete active missions
  const activeResp = await bot.exec("get_active_missions");
  let activeMissionCount = 0;
  if (!activeResp.error && activeResp.result) {
    const ar = activeResp.result as Record<string, unknown>;
    const active = (
      Array.isArray(ar.missions) ? ar.missions :
      Array.isArray(ar) ? ar :
      []
    ) as Array<Record<string, unknown>>;
    activeMissionCount = active.length;

    for (const mission of active) {
      const missionId = (mission.mission_id as string) || (mission.id as string) || "";
      if (!missionId) continue;
      // Only try to complete missions marked as ready/completable
      const status = ((mission.status as string) || "").toLowerCase();
      if (status === "incomplete" || status === "in_progress") continue;
      const completeResp = await bot.exec("complete_mission", { mission_id: missionId });
      if (completeResp.error) {
        // Silently skip mission_incomplete — expected for in-progress missions
        if (completeResp.error.code === "mission_incomplete") continue;
      }
      if (!completeResp.error && completeResp.result) {
        const cr = completeResp.result as Record<string, unknown>;
        const earned = (cr.credits_earned as number) ?? 0;
        ctx.log("trade", `Mission complete! +${earned}cr`);
        activeMissionCount--;
        await bot.refreshStatus();
      }
    }
  }

  // Accept new market/trade missions (cap at 5 total active)
  if (activeMissionCount >= 5) return;

  const availResp = await bot.exec("get_missions");
  if (availResp.error || !availResp.result) return;

  const vr = availResp.result as Record<string, unknown>;
  const available = (
    Array.isArray(vr.missions) ? vr.missions :
    Array.isArray(vr) ? vr :
    []
  ) as Array<Record<string, unknown>>;

  let accepted = 0;
  for (const mission of available) {
    if (activeMissionCount + accepted >= 5 || accepted >= 2) break;

    const missionId = (mission.mission_id as string) || (mission.id as string) || "";
    const type = ((mission.type as string) || "").toLowerCase();
    const title = ((mission.title as string) || "").toLowerCase();

    const isTradeRelated =
      type === "market_participation" || type === "trade" || type === "delivery" ||
      title.includes("market") || title.includes("trade") ||
      title.includes("sell") || title.includes("buy") || title.includes("deliver");

    if (!isTradeRelated || !missionId) continue;

    const acceptResp = await bot.exec("accept_mission", { mission_id: missionId });
    if (!acceptResp.error) {
      ctx.log("trade", `Accepted mission: ${(mission.title as string) || missionId}`);
      accepted++;
    }
  }
}

// ── Faction storage liquidation ───────────────────────────────

/**
 * Sell items from faction storage at the current station's market.
 * Withdraws non-fuel items that can be sold here, sells them, and logs profit.
 * Must be docked.
 */
async function sellFactionStorageItems(ctx: RoutineContext): Promise<number> {
  const { bot } = ctx;
  if (!bot.docked) return 0;

  await bot.refreshFactionStorage();
  if (bot.factionStorage.length === 0) return 0;

  // Get current station's market to check what's sellable
  const marketResp = await bot.exec("view_market");
  if (!marketResp.result || typeof marketResp.result !== "object") return 0;

  const marketData = marketResp.result as Record<string, unknown>;
  const listings = (
    Array.isArray(marketData) ? marketData :
    Array.isArray(marketData.items) ? marketData.items :
    Array.isArray(marketData.listings) ? marketData.listings :
    []
  ) as Array<Record<string, unknown>>;

  // Build set of items this market buys
  const buyableItems = new Set<string>();
  for (const listing of listings) {
    const itemId = (listing.item_id as string) || "";
    const buyPrice = (listing.buy_price as number) || (listing.best_sell as number) || 0;
    if (itemId && buyPrice > 0) buyableItems.add(itemId);
  }

  if (buyableItems.size === 0) return 0;

  // Find faction storage items we can sell here
  const toSell: Array<{ itemId: string; name: string; qty: number }> = [];
  for (const item of bot.factionStorage) {
    const lower = item.itemId.toLowerCase();
    if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
    if (!buyableItems.has(item.itemId)) continue;
    toSell.push({ itemId: item.itemId, name: item.name, qty: item.quantity });
  }

  if (toSell.length === 0) return 0;

  let totalSold = 0;
  const soldItems: string[] = [];

  for (const item of toSell) {
    // Check cargo space
    await bot.refreshStatus();
    const freeSpace = bot.cargoMax > 0 ? bot.cargoMax - bot.cargo : 999;
    if (freeSpace <= 0) break;

    const qty = Math.min(item.qty, freeSpace);
    if (qty <= 0) continue;

    // Withdraw from faction storage
    const wResp = await bot.exec("faction_withdraw_items", { item_id: item.itemId, quantity: qty });
    if (wResp.error) continue;

    // Sell immediately
    const sResp = await bot.exec("sell", { item_id: item.itemId, quantity: qty });
    if (!sResp.error) {
      totalSold += qty;
      soldItems.push(`${qty}x ${item.name}`);
    } else {
      // Sell failed — put back in faction storage
      await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: qty });
    }
  }

  if (soldItems.length > 0) {
    ctx.log("trade", `Sold from faction storage: ${soldItems.join(", ")}`);
    await bot.refreshStatus();
  }

  return totalSold;
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
  const startSystem = bot.system;

  while (bot.state === "running") {
    const settings = getTraderSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };

    // ── Ensure docked, collect storage, record market ──
    yield "dock";
    await ensureDocked(ctx);
    if (bot.docked) {
      await recordMarketData(ctx);
      await analyzeMarket(ctx);
      await tryMissions(ctx);
      await sellFactionStorageItems(ctx);
    }

    // ── Fuel + hull check ──
    yield "maintenance";
    await tryRefuel(ctx);
    await repairShip(ctx);

    // ── Find trade opportunities (market arbitrage + faction storage) ──
    yield "find_trades";
    await bot.refreshStatus();
    if (bot.docked) {
      await bot.refreshFactionStorage();
    }
    const marketRoutes = findTradeOpportunities(settings, bot.system);
    const factionRoutes = findFactionStorageRoutes(ctx, settings, bot.system);
    const routes = [...marketRoutes, ...factionRoutes].sort((a, b) => b.totalProfit - a.totalProfit);

    if (factionRoutes.length > 0) {
      ctx.log("trade", `Found ${marketRoutes.length} market routes + ${factionRoutes.length} faction storage routes`);
    }

    if (routes.length === 0) {
      ctx.log("trade", "No profitable trade routes found — waiting 60s before re-scanning");
      await sleep(60000);
      continue;
    }

    // Try up to 3 routes — skip stale/unavailable ones
    const MAX_ROUTE_ATTEMPTS = 3;
    let route: TradeRoute | null = null;
    let buyQty = 0;
    let investedCredits = 0;

    for (let ri = 0; ri < Math.min(routes.length, MAX_ROUTE_ATTEMPTS); ri++) {
      if (bot.state !== "running") break;
      const candidate = routes[ri];
      const isFactionRoute = candidate.sourcePoi === "";

      if (isFactionRoute) {
        ctx.log("trade", `Route #${ri + 1}: ${candidate.itemName} — withdraw ${candidate.buyQty}x from faction storage (cost: ${candidate.buyPrice}cr/ea) → sell at ${candidate.destPoiName} (${candidate.sellPrice}cr) — est. profit ${Math.round(candidate.totalProfit)}cr (${candidate.jumps} jumps)`);
      } else {
        ctx.log("trade", `Route #${ri + 1}: ${candidate.itemName} — buy ${candidate.buyQty}x at ${candidate.sourcePoiName} (${candidate.buyPrice}cr) → sell at ${candidate.destPoiName} (${candidate.sellPrice}cr) — est. profit ${Math.round(candidate.totalProfit)}cr (${candidate.jumps} jumps)`);
      }

      if (isFactionRoute) {
        // ── Faction storage route: withdraw from faction storage and sell ──
        yield "withdraw_faction";
        await ensureDocked(ctx);

        // Clear cargo: keep 3 fuel cells, deposit everything else
        const RESERVE_FC = 3;
        await bot.refreshCargo();
        for (const item of bot.inventory) {
          const lower = item.itemId.toLowerCase();
          const isFuel = lower.includes("fuel") || lower.includes("energy_cell");
          if (isFuel) {
            const excess = item.quantity - RESERVE_FC;
            if (excess > 0) await bot.exec("deposit_items", { item_id: item.itemId, quantity: excess });
          } else {
            await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
          }
        }

        // Withdraw target item from faction storage
        await bot.refreshFactionStorage();
        await bot.refreshStatus();
        const factionItem = bot.factionStorage.find(i => i.itemId === candidate.itemId);
        const availQty = factionItem ? factionItem.quantity : 0;
        const freeSpaceF = bot.cargoMax > 0 ? bot.cargoMax - bot.cargo : 999;
        let qty = Math.min(candidate.buyQty, availQty, freeSpaceF);

        if (qty <= 0) {
          ctx.log("trade", `${candidate.itemName} no longer in faction storage — trying next route`);
          continue;
        }

        const wResp = await bot.exec("faction_withdraw_items", { item_id: candidate.itemId, quantity: qty });
        if (wResp.error) {
          ctx.log("error", `Withdraw from faction storage failed: ${wResp.error.message} — trying next route`);
          continue;
        }

        route = candidate;
        buyQty = qty;
        investedCredits = qty * candidate.buyPrice; // material cost basis
        ctx.log("trade", `Withdrew ${qty}x ${candidate.itemName} from faction storage (material cost: ${investedCredits}cr)`);
        break;
      }

      // ── Normal market route: travel to source and buy ──
      yield "travel_to_source";

      if (bot.system !== candidate.sourceSystem) {
        await ensureUndocked(ctx);
        const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (!fueled) {
          ctx.log("error", "Cannot refuel for trade run — waiting 30s");
          await sleep(30000);
          break;
        }

        ctx.log("travel", `Heading to ${candidate.sourcePoiName} in ${candidate.sourceSystem}...`);
        const arrived = await navigateToSystem(ctx, candidate.sourceSystem, safetyOpts);
        if (!arrived) {
          ctx.log("error", "Failed to reach source system — trying next route");
          continue;
        }
      }

      await ensureUndocked(ctx);
      if (bot.poi !== candidate.sourcePoi) {
        ctx.log("travel", `Traveling to ${candidate.sourcePoiName}...`);
        const tResp = await bot.exec("travel", { target_poi: candidate.sourcePoi });
        if (tResp.error && !tResp.error.message.includes("already")) {
          ctx.log("error", `Travel to source failed: ${tResp.error.message}`);
          continue;
        }
        bot.poi = candidate.sourcePoi;
      }

      // Dock at source
      yield "dock_source";
      const dResp = await bot.exec("dock");
      if (dResp.error && !dResp.error.message.includes("already")) {
        ctx.log("error", `Dock failed at source: ${dResp.error.message}`);
        continue;
      }
      bot.docked = true;

      // Withdraw credits from storage and check for sellable items
      await bot.refreshStorage();
      const storageResp = await bot.exec("view_storage");
      if (storageResp.result && typeof storageResp.result === "object") {
        const sr = storageResp.result as Record<string, unknown>;
        const storedCredits = (sr.credits as number) || (sr.stored_credits as number) || 0;
        if (storedCredits > 0) {
          await bot.exec("withdraw_credits", { amount: storedCredits });
          ctx.log("trade", `Withdrew ${storedCredits} credits from storage`);
        }
      }

      // Check storage for items that can be sold at the destination for profit
      if (bot.storage.length > 0) {
        const destSys = mapStore.getSystem(candidate.destSystem);
        const destStation = destSys?.pois.find(p => p.id === candidate.destPoi);
        const destMarket = destStation?.market || [];

        const storageToSell: Array<{ itemId: string; name: string; qty: number }> = [];
        for (const item of bot.storage) {
          const lower = item.itemId.toLowerCase();
          if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
          // Check if destination has a buy price for this item
          const destItem = destMarket.find(m => m.item_id === item.itemId);
          if (destItem && destItem.best_sell !== null && destItem.best_sell > 0) {
            storageToSell.push({ itemId: item.itemId, name: item.name, qty: item.quantity });
          }
        }

        if (storageToSell.length > 0) {
          await bot.refreshStatus();
          const freeSpace = bot.cargoMax > 0 ? bot.cargoMax - bot.cargo : 999;
          let withdrawn = 0;
          const withdrawnItems: string[] = [];
          for (const si of storageToSell) {
            if (withdrawn >= freeSpace) break;
            const qty = Math.min(si.qty, freeSpace - withdrawn);
            if (qty <= 0) continue;
            const wResp = await bot.exec("withdraw_items", { item_id: si.itemId, quantity: qty });
            if (!wResp.error) {
              withdrawn += qty;
              withdrawnItems.push(`${qty}x ${si.name}`);
            }
          }
          if (withdrawnItems.length > 0) {
            ctx.log("trade", `Withdrew from storage to sell at dest: ${withdrawnItems.join(", ")}`);
          }
        }
      }

      // Record fresh market data at source and accept missions here too
      await recordMarketData(ctx);
      await tryMissions(ctx);

      // Verify item is actually available via estimate_purchase
      yield "verify_availability";
      const estResp = await bot.exec("estimate_purchase", { item_id: candidate.itemId, quantity: 1 });
      if (estResp.error) {
        ctx.log("trade", `${candidate.itemName} not available at ${candidate.sourcePoiName} (stale data) — trying next route`);
        continue;
      }

      // Clear cargo: keep 3 fuel cells, deposit everything else
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

      // Ensure we have at least RESERVE_FUEL_CELLS fuel cells
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

      // Determine buy quantity
      await bot.refreshStatus();
      const freeSpace = bot.cargoMax > 0 ? bot.cargoMax - bot.cargo : 999;
      let qty = Math.min(candidate.buyQty, freeSpace);
      if (settings.maxCargoValue > 0) {
        qty = Math.min(qty, Math.floor(settings.maxCargoValue / candidate.buyPrice));
      }
      qty = Math.min(qty, Math.floor(bot.credits / candidate.buyPrice));

      if (qty <= 0) {
        ctx.log("trade", "Cannot afford any items or cargo full — trying next route");
        continue;
      }

      // Buy items
      yield "buy";
      ctx.log("trade", `Buying ${qty}x ${candidate.itemName} at ${candidate.buyPrice}cr/ea...`);
      const buyResp = await bot.exec("buy", { item_id: candidate.itemId, quantity: qty });
      if (buyResp.error) {
        ctx.log("error", `Buy failed: ${buyResp.error.message} — trying next route`);
        continue;
      }

      await bot.refreshStatus();
      route = candidate;
      buyQty = qty;
      investedCredits = qty * candidate.buyPrice;
      ctx.log("trade", `Purchased ${buyQty}x ${candidate.itemName} for ${investedCredits}cr`);
      break;
    }

    // Insure the loaded ship before departing (still docked at source)
    if (route && buyQty > 0 && settings.autoInsure) {
      await tryInsureShip(ctx, investedCredits);
    }

    // No route worked — wait and retry
    if (!route || buyQty <= 0) {
      ctx.log("trade", "All routes failed — waiting 60s before re-scanning");
      await sleep(60000);
      continue;
    }

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
    await tryMissions(ctx);

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

    // Also sell any other non-fuel items from cargo (e.g. items withdrawn from storage)
    await bot.refreshCargo();
    for (const item of bot.inventory) {
      if (item.itemId === route.itemId) continue; // already sold above
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
      if (item.quantity <= 0) continue;
      const sResp = await bot.exec("sell", { item_id: item.itemId, quantity: item.quantity });
      if (!sResp.error) {
        ctx.log("trade", `Sold ${item.quantity}x ${item.name} from storage`);
      } else {
        // Can't sell here — deposit to faction storage (shared pool)
        const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
        if (fResp.error) {
          await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        }
      }
    }

    // Sell faction storage items at this market too
    await sellFactionStorageItems(ctx);

    await bot.refreshStatus();
    const creditsAfter = bot.credits;
    const actualProfit = creditsAfter - creditsBefore + investedCredits;
    bot.stats.totalTrades++;
    bot.stats.totalProfit += actualProfit;

    // Record market data at destination
    await recordMarketData(ctx);

    // ── Trade summary ──
    ctx.log("trade", `Trade run complete: ${buyQty}x ${route.itemName} — bought at ${route.sourcePoiName} (${route.buyPrice}cr/ea), sold at ${route.destPoiName} (${route.sellPrice}cr/ea) — profit ${actualProfit}cr (${route.jumps} jumps)`);

    // ── Faction donation (10% of profit) ──
    await factionDonateProfit(ctx, actualProfit);

    // ── Maintenance ──
    yield "post_trade_maintenance";
    await tryRefuel(ctx);
    await repairShip(ctx);

    // ── Check skills ──
    yield "check_skills";
    await bot.checkSkills();

    // ── Return home ──
    const homeSystem = settings.homeSystem || startSystem;
    if (homeSystem && bot.system !== homeSystem) {
      yield "return_home";
      ctx.log("travel", `Returning to home system ${homeSystem}...`);
      const homeFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!homeFueled) {
        ctx.log("error", "Cannot refuel for return home — will try next cycle");
      } else {
        await ensureUndocked(ctx);
        const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
        if (arrived) {
          // Dock at home station
          const { pois: homePois } = await getSystemInfo(ctx);
          const homeStation = findStation(homePois);
          if (homeStation) {
            await bot.exec("travel", { target_poi: homeStation.id });
            await bot.exec("dock");
            bot.docked = true;
            bot.poi = homeStation.id;
            ctx.log("travel", `Docked at home station ${homeStation.name}`);
          }
        } else {
          ctx.log("error", "Failed to return home — will retry next cycle");
        }
      }
    }

    await bot.refreshStatus();
    const endFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Credits: ${bot.credits} | Fuel: ${endFuel}% | Cargo: ${bot.cargo}/${bot.cargoMax}`);
  }
};
