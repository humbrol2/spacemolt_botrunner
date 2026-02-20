import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import {
  type SystemPOI,
  type Connection,
  isMinablePoi,
  isScenicPoi,
  isStationPoi,
  findStation,
  getSystemInfo,
  parseOreFromMineResult,
  collectFromStorage,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  depositCargoAtHome,
  fetchSecurityLevel,
  scavengeWrecks,
  sleep,
} from "./common.js";

/** Number of mine attempts per resource POI to sample ores. */
const SAMPLE_MINES = 5;
/** Minimum fuel % before heading back to refuel. */
const FUEL_SAFETY_PCT = 40;
/** Minimum fuel % required before attempting a system jump. */
const JUMP_FUEL_PCT = 70;

/** Minutes before a station's market/orders/missions data is considered stale. */
const STATION_REFRESH_MINS = 30;
/** Minutes before a resource POI should be re-sampled. */
const RESOURCE_REFRESH_MINS = 120;

/**
 * Explorer routine — systematically maps the galaxy:
 *
 * Exploration logic per POI:
 *   - Scenic (sun, star, gate): visit once, never revisit
 *   - Resource (belt, gas cloud, etc.): sample mine, revisit every RESOURCE_REFRESH_MINS
 *   - Station: dock, scan market/orders/missions, revisit every STATION_REFRESH_MINS
 *   - Other (planet, anomaly, etc.): check nearby, revisit every RESOURCE_REFRESH_MINS
 *
 * After visiting all POIs in a system, jump to least-explored connected system.
 */
export const explorerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;
  const visitedSystems = new Set<string>();

  // ── Startup: dock at local station to clear cargo & refuel ──
  yield "startup_prep";
  await bot.refreshStatus();
  const { pois: startPois } = await getSystemInfo(ctx);
  const startStation = findStation(startPois);
  if (startStation) {
    ctx.log("system", `Startup: docking at ${startStation.name} to clear cargo & refuel...`);

    // Travel to station if not already there
    if (bot.poi !== startStation.id) {
      await ensureUndocked(ctx);
      const tResp = await bot.exec("travel", { target_poi: startStation.id });
      if (tResp.error && !tResp.error.message.includes("already")) {
        ctx.log("error", `Could not reach station: ${tResp.error.message}`);
      }
    }

    // Dock
    if (!bot.docked) {
      const dResp = await bot.exec("dock");
      if (!dResp.error || dResp.error.message.includes("already")) {
        bot.docked = true;
      }
    }

    if (bot.docked) {
      // Collect gifted credits/items from storage
      await collectFromStorage(ctx);

      // Deposit non-fuel cargo
      yield "startup_deposit";
      const cargoResp = await bot.exec("get_cargo");
      if (cargoResp.result && typeof cargoResp.result === "object") {
        const cResult = cargoResp.result as Record<string, unknown>;
        const cargoItems = (
          Array.isArray(cResult) ? cResult :
          Array.isArray(cResult.items) ? (cResult.items as Array<Record<string, unknown>>) :
          Array.isArray(cResult.cargo) ? (cResult.cargo as Array<Record<string, unknown>>) :
          []
        );
        let deposited = 0;
        for (const item of cargoItems) {
          const itemId = (item.item_id as string) || "";
          const quantity = (item.quantity as number) || 0;
          if (!itemId || quantity <= 0) continue;
          const lower = itemId.toLowerCase();
          if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
          const displayName = (item.name as string) || itemId;
          ctx.log("trade", `Depositing ${quantity}x ${displayName}...`);
          await bot.exec("deposit_items", { item_id: itemId, quantity });
          deposited += quantity;
        }
        if (deposited > 0) ctx.log("trade", `Deposited ${deposited} items to storage`);
      }

      // Refuel
      yield "startup_refuel";
      await tryRefuel(ctx);
      await bot.refreshStatus();
      const startFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      ctx.log("system", `Startup complete — Fuel: ${startFuel}% | Cargo: ${bot.cargo}/${bot.cargoMax}`);
    }
  } else {
    ctx.log("system", "No station in current system — skipping startup prep");
  }

  while (bot.state === "running") {
    // ── Get current system data ──
    yield "scan_system";
    await bot.refreshStatus();
    const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `=== Exploring ${bot.system} | Credits: ${bot.credits} | Fuel: ${fuelPct}% | Cargo: ${bot.cargo}/${bot.cargoMax} ===`);

    const { pois, connections, systemId } = await getSystemInfo(ctx);
    if (!systemId) {
      ctx.log("error", "Could not determine current system — waiting 30s");
      await sleep(30000);
      continue;
    }
    visitedSystems.add(systemId);

    // Try to capture security level
    await fetchSecurityLevel(ctx, systemId);

    // ── Classify POIs and determine what needs visiting ──
    const toVisit: Array<{ poi: SystemPOI; reason: string }> = [];
    let skippedCount = 0;

    for (const poi of pois) {
      const isStation = isStationPoi(poi);
      const isMinable = isMinablePoi(poi.type);
      const isScenic = isScenicPoi(poi.type);
      const minutesAgo = mapStore.minutesSinceExplored(systemId, poi.id);

      if (isStation) {
        if (minutesAgo < STATION_REFRESH_MINS) { skippedCount++; continue; }
        toVisit.push({ poi, reason: minutesAgo === Infinity ? "new" : "refresh" });
      } else if (isMinable) {
        // Always re-visit if explored but no ores were recorded
        const storedPoi = mapStore.getSystem(systemId)?.pois.find(p => p.id === poi.id);
        const hasOreData = (storedPoi?.ores_found?.length ?? 0) > 0;
        if (minutesAgo < RESOURCE_REFRESH_MINS && hasOreData) { skippedCount++; continue; }
        toVisit.push({ poi, reason: minutesAgo === Infinity ? "new" : (hasOreData ? "re-sample" : "no-data") });
      } else if (isScenic) {
        if (minutesAgo < Infinity) { skippedCount++; continue; }
        toVisit.push({ poi, reason: "new" });
      } else {
        if (minutesAgo < RESOURCE_REFRESH_MINS) { skippedCount++; continue; }
        toVisit.push({ poi, reason: minutesAgo === Infinity ? "new" : "refresh" });
      }
    }

    ctx.log("info", `System ${systemId}: ${toVisit.length} POIs to visit, ${skippedCount} already explored`);

    if (toVisit.length === 0) {
      ctx.log("info", "All POIs in this system are up to date — moving on");
    }

    // ── Hull check — repair if <= 40% ──
    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= 40) {
      ctx.log("system", `Hull critical (${hullPct}%) — finding station for repair`);
      const docked = await ensureDocked(ctx);
      if (docked) {
        await repairShip(ctx);
      }
    }

    // ── Ensure fueled before exploring ──
    yield "fuel_check";
    const fueled = await ensureFueled(ctx, FUEL_SAFETY_PCT);
    if (!fueled) {
      ctx.log("error", "Could not refuel — waiting 30s before retry...");
      await sleep(30000);
      continue;
    }

    // If hull repair or refueling moved us to a different system, restart the loop
    await bot.refreshStatus();
    if (bot.system !== systemId) {
      ctx.log("info", `Moved to ${bot.system} during repair/refuel — restarting system scan`);
      continue;
    }

    // ── Undock if docked ──
    await ensureUndocked(ctx);

    // Find station for emergency refueling
    const station = findStation(pois);

    // ── Visit each POI ──
    for (const { poi, reason } of toVisit) {
      if (bot.state !== "running") break;

      const isMinable = isMinablePoi(poi.type);
      const isStation = isStationPoi(poi);

      // Check fuel before traveling to each POI
      yield "fuel_check";
      const poiFueled = await ensureFueled(ctx, FUEL_SAFETY_PCT);
      if (!poiFueled) {
        ctx.log("error", "Could not refuel — restarting system loop...");
        break;
      }
      // If refueling moved us to a different system, break out to restart
      await bot.refreshStatus();
      if (bot.system !== systemId) {
        ctx.log("info", `Moved to ${bot.system} during refuel — restarting system scan`);
        break;
      }
      await ensureUndocked(ctx);

      yield `visit_${poi.id}`;
      const tag = reason === "new" ? "" : ` [${reason}]`;
      ctx.log("travel", `Traveling to ${poi.name} [${poi.type}]${tag}...`);
      const travelResp = await bot.exec("travel", { target_poi: poi.id });
      if (travelResp.error && !travelResp.error.message.includes("already")) {
        ctx.log("error", `Travel to ${poi.name} failed: ${travelResp.error.message}`);
        continue;
      }
      bot.poi = poi.id;

      // Scavenge wrecks/containers at each POI
      yield "scavenge";
      await scavengeWrecks(ctx);

      if (isMinable) {
        yield* sampleResourcePoi(ctx, systemId, poi);
      } else if (isStation) {
        yield* scanStation(ctx, systemId, poi);
      } else {
        yield* visitOtherPoi(ctx, systemId, poi);
      }

      // ── Check cargo — if full, return to Sol Central to deposit ──
      await bot.refreshStatus();
      if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) {
        yield "deposit_cargo";
        await depositCargoAtHome(ctx, { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30 });
        // After depositing, we're likely in Sol — break to restart system scan
        await bot.refreshStatus();
        if (bot.system !== systemId) {
          ctx.log("info", `Moved to ${bot.system} after deposit — restarting system scan`);
          break;
        }
      }
    }

    if (bot.state !== "running") break;

    // ── Check skills for level-ups ──
    yield "check_skills";
    await bot.checkSkills();

    // ── Pick next system to explore ──
    yield "pick_next_system";

    // ALWAYS ensure fueled before jumping — will navigate to nearest station if needed
    yield "pre_jump_fuel";
    const jumpFueled = await ensureFueled(ctx, JUMP_FUEL_PCT);
    if (!jumpFueled) {
      ctx.log("error", "Could not refuel before jump — waiting 30s...");
      await sleep(30000);
      continue;
    }

    const validConns = connections.filter(c => c.id);
    const nextSystem = pickNextSystem(validConns, visitedSystems);
    if (!nextSystem) {
      ctx.log("info", "All connected systems explored! Picking a random connection...");
      if (validConns.length > 0) {
        // Ensure fuel before random jump
        const rndFueled = await ensureFueled(ctx, JUMP_FUEL_PCT);
        if (!rndFueled) {
          ctx.log("error", "Cannot refuel for random jump — waiting 30s...");
          await sleep(30000);
          continue;
        }
        const random = validConns[Math.floor(Math.random() * validConns.length)];
        await ensureUndocked(ctx);
        ctx.log("travel", `Jumping to ${random.name || random.id}...`);
        const jumpResp = await bot.exec("jump", { target_system: random.id });
        if (jumpResp.error) {
          ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
          await sleep(10000);
        }
      } else {
        ctx.log("error", "No connections from this system — stuck! Waiting 60s...");
        await sleep(60000);
      }
      continue;
    }

    // Final fuel verify before jumping
    await bot.refreshStatus();
    const preJumpFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (preJumpFuel < 25) {
      ctx.log("system", `Fuel too low for jump (${preJumpFuel}%) — refueling first...`);
      const jf = await ensureFueled(ctx, JUMP_FUEL_PCT);
      if (!jf) {
        ctx.log("error", "Cannot refuel — waiting 30s...");
        await sleep(30000);
        continue;
      }
    }

    await ensureUndocked(ctx);
    ctx.log("travel", `Jumping to ${nextSystem.name || nextSystem.id}...`);
    const jumpResp = await bot.exec("jump", { target_system: nextSystem.id });
    if (jumpResp.error) {
      const msg = jumpResp.error.message.toLowerCase();
      if (msg.includes("fuel")) {
        ctx.log("error", "Insufficient fuel for jump — will refuel next loop");
      } else {
        ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
      }
      await sleep(10000);
      continue;
    }

    ctx.log("info", `=== Arrived in ${nextSystem.name || nextSystem.id} ===`);
  }
};

// ── POI visit sub-routines ───────────────────────────────────

/** Sample mine at a resource POI to discover ores. */
async function* sampleResourcePoi(
  ctx: RoutineContext,
  systemId: string,
  poi: SystemPOI,
): AsyncGenerator<string, void, void> {
  const { bot } = ctx;
  yield `sample_${poi.id}`;
  ctx.log("mining", `Sampling resources at ${poi.name} [${poi.type}]...`);
  const oresFound = new Set<string>();
  let mined = 0;
  let cantMine = false;

  for (let i = 0; i < SAMPLE_MINES && bot.state === "running"; i++) {
    const mineResp = await bot.exec("mine");

    if (mineResp.error) {
      const msg = mineResp.error.message.toLowerCase();
      if (msg.includes("no asteroids") || msg.includes("depleted") || msg.includes("no minable") || msg.includes("nothing to mine")) {
        ctx.log("mining", `${poi.name}: depleted after ${mined} samples`);
        break;
      }
      if (msg.includes("cargo") && msg.includes("full")) {
        ctx.log("mining", "Cargo full — will deposit at station");
        break;
      }
      if (mined === 0) {
        cantMine = true;
        ctx.log("mining", `${poi.name}: cannot mine here (${mineResp.error.message}) — leaving unmarked`);
      } else {
        ctx.log("error", `Mine error at ${poi.name}: ${mineResp.error.message}`);
      }
      break;
    }

    mined++;

    const { oreId, oreName } = parseOreFromMineResult(mineResp.result);
    if (oreId) {
      mapStore.recordMiningYield(systemId, poi.id, { item_id: oreId, name: oreName });
      oresFound.add(oreName);
    }

    yield "sampling";
  }

  if (oresFound.size > 0) {
    ctx.log("mining", `${poi.name}: found ${[...oresFound].join(", ")}`);
  } else if (mined === 0 && !cantMine) {
    ctx.log("mining", `${poi.name}: no resources available`);
  }

  if (!cantMine) {
    mapStore.markExplored(systemId, poi.id);
  }
}

/** Dock at station, scan market/orders/missions, refuel. */
async function* scanStation(
  ctx: RoutineContext,
  systemId: string,
  poi: SystemPOI,
): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  yield `dock_${poi.id}`;
  ctx.log("system", `Docking at ${poi.name}...`);
  const dockResp = await bot.exec("dock");
  if (dockResp.error && !dockResp.error.message.includes("already")) {
    ctx.log("error", `Dock failed at ${poi.name}: ${dockResp.error.message}`);
    return;
  }
  bot.docked = true;

  // Collect gifted credits/items from storage
  await collectFromStorage(ctx);

  // Scan market
  yield `market_${poi.id}`;
  ctx.log("trade", `Scanning market at ${poi.name}...`);
  const marketResp = await bot.exec("view_market");
  if (marketResp.result && typeof marketResp.result === "object") {
    mapStore.updateMarket(systemId, poi.id, marketResp.result as Record<string, unknown>);
    const result = marketResp.result as Record<string, unknown>;
    const items = (
      Array.isArray(result) ? result :
      Array.isArray(result.items) ? result.items :
      Array.isArray(result.market) ? result.market :
      []
    ) as unknown[];
    ctx.log("trade", `Market: ${items.length} items recorded`);
  }

  // Scan orders
  yield `orders_${poi.id}`;
  const ordersResp = await bot.exec("view_orders");
  if (ordersResp.result && typeof ordersResp.result === "object") {
    const ordersData = ordersResp.result as Record<string, unknown>;
    const orders = (
      Array.isArray(ordersData) ? ordersData :
      Array.isArray(ordersData.orders) ? ordersData.orders :
      Array.isArray(ordersData.buy_orders) || Array.isArray(ordersData.sell_orders)
        ? [...(ordersData.buy_orders as unknown[] || []), ...(ordersData.sell_orders as unknown[] || [])]
        : []
    ) as Array<Record<string, unknown>>;
    if (orders.length > 0) {
      mapStore.updateOrders(systemId, poi.id, orders);
      ctx.log("trade", `Orders: ${orders.length} player orders recorded`);
    }
  }

  // Scan missions
  yield `missions_${poi.id}`;
  ctx.log("info", `Scanning missions at ${poi.name}...`);
  const missionsResp = await bot.exec("get_missions");
  if (missionsResp.result && typeof missionsResp.result === "object") {
    const mData = missionsResp.result as Record<string, unknown>;
    const missions = (
      Array.isArray(mData) ? mData :
      Array.isArray(mData.missions) ? mData.missions :
      Array.isArray(mData.available) ? mData.available :
      Array.isArray(mData.available_missions) ? mData.available_missions :
      []
    ) as Array<Record<string, unknown>>;
    if (missions.length > 0) {
      mapStore.updateMissions(systemId, poi.id, missions);
      ctx.log("info", `Missions: ${missions.length} available`);
    } else {
      ctx.log("info", "No missions available");
    }
  }

  // Refuel
  yield `refuel_${poi.id}`;
  await bot.refreshStatus();
  const stationFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (stationFuel < 90) {
    await tryRefuel(ctx);
  }

  // Deposit non-fuel cargo to station storage
  yield `deposit_${poi.id}`;
  const cargoResp = await bot.exec("get_cargo");
  if (cargoResp.result && typeof cargoResp.result === "object") {
    const cResult = cargoResp.result as Record<string, unknown>;
    const cargoItems = (
      Array.isArray(cResult) ? cResult :
      Array.isArray(cResult.items) ? cResult.items :
      Array.isArray(cResult.cargo) ? cResult.cargo :
      []
    ) as Array<Record<string, unknown>>;

    for (const item of cargoItems) {
      const itemId = (item.item_id as string) || "";
      const quantity = (item.quantity as number) || 0;
      if (!itemId || quantity <= 0) continue;
      // Keep fuel cells for emergency use
      const lower = itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) continue;

      const displayName = (item.name as string) || itemId;
      ctx.log("trade", `Depositing ${quantity}x ${displayName} to storage...`);
      await bot.exec("deposit_items", { item_id: itemId, quantity });
      yield "depositing";
    }
  }

  // Undock
  yield `undock_${poi.id}`;
  ctx.log("system", "Undocking...");
  await bot.exec("undock");
  bot.docked = false;

  mapStore.markExplored(systemId, poi.id);
}

/** Visit a non-minable, non-station POI — check what's nearby. */
async function* visitOtherPoi(
  ctx: RoutineContext,
  systemId: string,
  poi: SystemPOI,
): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  yield `scan_${poi.id}`;
  ctx.log("info", `Visited ${poi.name} [${poi.type}]`);
  const nearbyResp = await bot.exec("get_nearby");
  if (nearbyResp.result && typeof nearbyResp.result === "object") {
    const nr = nearbyResp.result as Record<string, unknown>;
    const objects = (nr.objects || nr.results || nr.ships || nr.players || []) as unknown[];
    if (objects.length > 0) {
      ctx.log("info", `Nearby: ${objects.length} objects detected`);
    }
  }

  mapStore.markExplored(systemId, poi.id);
}

// ── Helpers ──────────────────────────────────────────────────

/** Pick the best next system: prefer unvisited, then least-explored in mapStore. */
function pickNextSystem(connections: Connection[], visited: Set<string>): Connection | null {
  const unvisited = connections.filter(c => !visited.has(c.id));
  if (unvisited.length > 0) {
    const unmapped = unvisited.filter(c => !mapStore.getSystem(c.id));
    if (unmapped.length > 0) return unmapped[0];

    unvisited.sort((a, b) => {
      const aPois = mapStore.getSystem(a.id)?.pois?.length ?? 0;
      const bPois = mapStore.getSystem(b.id)?.pois?.length ?? 0;
      return aPois - bPois;
    });
    return unvisited[0];
  }

  return null;
}
