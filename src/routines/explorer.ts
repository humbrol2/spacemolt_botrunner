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
  navigateToSystem,
  fetchSecurityLevel,
  scavengeWrecks,
  readSettings,
  sleep,
} from "./common.js";

/** Number of mine attempts per resource POI to sample ores. */
const SAMPLE_MINES = 5;
/** Minimum fuel % before heading back to refuel. */
const FUEL_SAFETY_PCT = 40;
/** Minimum fuel % required before attempting a system jump. */
const JUMP_FUEL_PCT = 70;

// ── Mission helpers ───────────────────────────────────────────

const EXPLORER_MISSION_KEYWORDS = [
  "explore", "survey", "scan", "chart", "discover", "map", "navigate",
  "visit", "investigate", "reconnaissance", "recon", "scout", "patrol",
  "deliver", "supply", "collect",
];

/** Accept available exploration missions at the current station. Respects 5-mission cap. */
async function checkAndAcceptMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  const activeResp = await bot.exec("get_active_missions");
  let activeCount = 0;
  if (activeResp.result && typeof activeResp.result === "object") {
    const r = activeResp.result as Record<string, unknown>;
    const list = Array.isArray(r) ? r : Array.isArray(r.missions) ? r.missions : [];
    activeCount = (list as unknown[]).length;
  }
  if (activeCount >= 5) return;

  const availResp = await bot.exec("get_missions");
  if (!availResp.result || typeof availResp.result !== "object") return;
  const r = availResp.result as Record<string, unknown>;
  const available = (
    Array.isArray(r) ? r :
    Array.isArray(r.missions) ? r.missions : []
  ) as Array<Record<string, unknown>>;

  for (const mission of available) {
    if (activeCount >= 5) break;
    const missionId = (mission.id as string) || (mission.mission_id as string) || "";
    if (!missionId) continue;
    const name = ((mission.name as string) || "").toLowerCase();
    const desc = ((mission.description as string) || "").toLowerCase();
    const type = ((mission.type as string) || "").toLowerCase();
    const isExplorerMission = EXPLORER_MISSION_KEYWORDS.some(kw =>
      name.includes(kw) || desc.includes(kw) || type.includes(kw)
    );
    if (!isExplorerMission) continue;
    const acceptResp = await bot.exec("accept_mission", { mission_id: missionId });
    if (!acceptResp.error) {
      activeCount++;
      ctx.log("info", `Mission accepted: ${(mission.name as string) || missionId} (${activeCount}/5 active)`);
    }
  }
}

/** Complete any active missions while docked. */
async function completeActiveMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  const activeResp = await bot.exec("get_active_missions");
  if (!activeResp.result || typeof activeResp.result !== "object") return;
  const r = activeResp.result as Record<string, unknown>;
  const missions = (
    Array.isArray(r) ? r :
    Array.isArray(r.missions) ? r.missions : []
  ) as Array<Record<string, unknown>>;

  for (const mission of missions) {
    const missionId = (mission.id as string) || (mission.mission_id as string) || "";
    if (!missionId) continue;
    const completeResp = await bot.exec("complete_mission", { mission_id: missionId });
    if (!completeResp.error) {
      const reward = (mission.reward as number) || (mission.reward_credits as number) || 0;
      ctx.log("trade", `Mission complete: ${(mission.name as string) || missionId}${reward > 0 ? ` (+${reward} credits)` : ""}`);
      await bot.refreshStatus();
    }
  }
}

/** Minutes before a station's market/orders/missions data is considered stale. */
const STATION_REFRESH_MINS = 30;
/** Minutes before a resource POI should be re-sampled. */
const RESOURCE_REFRESH_MINS = 120;

// ── Per-bot settings ─────────────────────────────────────────

export type ExplorerMode = "explore" | "trade_update";

function getExplorerSettings(username?: string): {
  mode: ExplorerMode;
  acceptMissions: boolean;
} {
  const all = readSettings();
  const botOverrides = username ? (all[username] || {}) : {};
  const mode = (botOverrides.explorerMode as string) || "explore";
  const e = all.explorer || {};

  // acceptMissions: per-bot > global explorer > default true
  const acceptMissions = botOverrides.acceptMissions !== undefined
    ? Boolean(botOverrides.acceptMissions)
    : e.acceptMissions !== undefined
      ? Boolean(e.acceptMissions)
      : true;

  return {
    mode: (mode === "trade_update" ? "trade_update" : "explore") as ExplorerMode,
    acceptMissions,
  };
}

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

  // Check per-bot mode
  const initialSettings = getExplorerSettings(bot.username);
  if (initialSettings.mode === "trade_update") {
    yield* tradeUpdateRoutine(ctx);
    return;
  }

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
    ctx.log("info", `Exploring ${bot.system} — ${bot.credits} cr, ${fuelPct}% fuel, ${bot.cargo}/${bot.cargoMax} cargo`);

    let { pois, connections, systemId } = await getSystemInfo(ctx);
    if (!systemId) {
      ctx.log("error", "Could not determine current system — waiting 30s");
      await sleep(30000);
      continue;
    }
    visitedSystems.add(systemId);

    // Try to capture security level
    await fetchSecurityLevel(ctx, systemId);

    // ── Survey the system to reveal hidden POIs ──
    yield "survey_system";
    const surveyResp = await bot.exec("survey_system");
    if (!surveyResp.error) {
      ctx.log("info", `Surveyed ${bot.system} — checking for newly revealed POIs...`);
      // Re-fetch system info to pick up any hidden POIs that were revealed
      const refreshed = await getSystemInfo(ctx);
      if (refreshed.pois.length > pois.length) {
        ctx.log("info", `Survey revealed ${refreshed.pois.length - pois.length} new POI(s)!`);
      }
      pois = refreshed.pois;
      connections = refreshed.connections;
    } else {
      const msg = surveyResp.error.message.toLowerCase();
      // Don't log for expected errors like "already surveyed" or skill-related
      if (!msg.includes("already") && !msg.includes("cooldown")) {
        ctx.log("info", `Survey: ${surveyResp.error.message}`);
      }
    }

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

    if (toVisit.length === 0) {
      ctx.log("info", `${bot.system}: all ${skippedCount} POIs up to date — moving on`);
    } else {
      ctx.log("info", `${bot.system}: ${toVisit.length} to visit, ${skippedCount} already explored`);
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

    ctx.log("travel", `Jumped to ${nextSystem.name || nextSystem.id}`);
    bot.stats.totalSystems++;
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
  const oresFound = new Set<string>();
  let mined = 0;
  let cantMine = false;

  for (let i = 0; i < SAMPLE_MINES && bot.state === "running"; i++) {
    const mineResp = await bot.exec("mine");

    if (mineResp.error) {
      const msg = mineResp.error.message.toLowerCase();
      if (msg.includes("no asteroids") || msg.includes("depleted") || msg.includes("no minable") || msg.includes("nothing to mine")) break;
      if (msg.includes("cargo") && msg.includes("full")) break;
      if (mined === 0) cantMine = true;
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

  // Single summary line
  if (oresFound.size > 0) {
    ctx.log("mining", `Sampled ${poi.name}: ${[...oresFound].join(", ")} (${mined} cycles)`);
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
  const dockResp = await bot.exec("dock");
  if (dockResp.error && !dockResp.error.message.includes("already")) {
    ctx.log("error", `Dock failed at ${poi.name}: ${dockResp.error.message}`);
    return;
  }
  bot.docked = true;

  await collectFromStorage(ctx);

  // Complete active missions (while cargo still intact from exploration)
  const stationSettings = getExplorerSettings(bot.username);
  if (stationSettings.acceptMissions) {
    yield `complete_missions_${poi.id}`;
    await completeActiveMissions(ctx);
  }

  // Scan market, orders, missions — collect stats for summary
  yield `scan_${poi.id}`;
  let marketCount = 0;
  let missionCount = 0;

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
    marketCount = items.length;
  }

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
      missionCount = missions.length;
    }
  }

  // Station scan summary
  const scanParts: string[] = [];
  if (marketCount > 0) scanParts.push(`${marketCount} market items`);
  if (missionCount > 0) scanParts.push(`${missionCount} missions`);
  ctx.log("info", `Scanned ${poi.name}: ${scanParts.length > 0 ? scanParts.join(", ") : "empty station"}`);

  // Refuel
  yield `refuel_${poi.id}`;
  await bot.refreshStatus();
  const stationFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (stationFuel < 90) {
    await tryRefuel(ctx);
  }

  // Deposit non-fuel cargo to station storage
  yield `deposit_${poi.id}`;
  const depositedItems: string[] = [];
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
      const lower = itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) continue;

      const displayName = (item.name as string) || itemId;
      await bot.exec("deposit_items", { item_id: itemId, quantity });
      depositedItems.push(`${quantity}x ${displayName}`);
      yield "depositing";
    }
  }
  if (depositedItems.length > 0) {
    ctx.log("trade", `Deposited ${depositedItems.join(", ")} to storage`);
  }

  // Accept new exploration missions before leaving
  if (stationSettings.acceptMissions) {
    yield `accept_missions_${poi.id}`;
    await checkAndAcceptMissions(ctx);
  }

  // Undock
  yield `undock_${poi.id}`;
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
  const nearbyResp = await bot.exec("get_nearby");
  if (nearbyResp.result && typeof nearbyResp.result === "object") {
    const nr = nearbyResp.result as Record<string, unknown>;
    const objects = (nr.objects || nr.results || nr.ships || nr.players || []) as unknown[];
    if (objects.length > 0) {
      ctx.log("info", `Visited ${poi.name}: ${objects.length} objects nearby`);
    }
  }

  mapStore.markExplored(systemId, poi.id);
}

// ── Trade Update routine ─────────────────────────────────────

/**
 * Trade update mode — cycles through known systems with stations,
 * refreshing market/orders/missions data. Stays in known space.
 */
async function* tradeUpdateRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await bot.refreshStatus();
  const homeSystem = bot.system;

  ctx.log("system", "Trade Update mode — cycling known stations to refresh market data...");

  // ── Startup: dock, refuel, deposit cargo ──
  yield "startup_prep";
  const { pois: startPois } = await getSystemInfo(ctx);
  const startStation = findStation(startPois);
  if (startStation) {
    if (bot.poi !== startStation.id) {
      await ensureUndocked(ctx);
      await bot.exec("travel", { target_poi: startStation.id });
    }
    await ensureDocked(ctx);
    await collectFromStorage(ctx);
    await tryRefuel(ctx);
    await bot.refreshStatus();
  }

  while (bot.state === "running") {
    // Re-read settings each cycle — user might switch mode mid-run
    const modeCheck = getExplorerSettings(bot.username);
    if (modeCheck.mode !== "trade_update") {
      ctx.log("system", "Mode changed to explore — restarting as explorer...");
      break;
    }

    // ── Build list of known systems with stations, sorted by stalest market data ──
    yield "plan_route";
    const allSystems = mapStore.getAllSystems();
    const stationSystems: Array<{ systemId: string; systemName: string; stationPoi: string; stationName: string; staleMins: number }> = [];

    for (const [sysId, sys] of Object.entries(allSystems)) {
      for (const poi of sys.pois) {
        if (!poi.has_base) continue;
        // Find the stalest market entry, or Infinity if no market data
        let oldestMins = Infinity;
        if (poi.market && poi.market.length > 0) {
          for (const m of poi.market) {
            if (m.last_updated) {
              const mins = (Date.now() - new Date(m.last_updated).getTime()) / 60000;
              if (mins < oldestMins) oldestMins = mins;
            }
          }
        }
        stationSystems.push({
          systemId: sysId,
          systemName: sys.name,
          stationPoi: poi.id,
          stationName: poi.name,
          staleMins: oldestMins,
        });
      }
    }

    // Sort: stalest data first (or no data = Infinity first)
    stationSystems.sort((a, b) => b.staleMins - a.staleMins);

    if (stationSystems.length === 0) {
      ctx.log("info", "No known stations on map — run an explorer in 'explore' mode first. Waiting 60s...");
      await sleep(60000);
      continue;
    }

    ctx.log("info", `Found ${stationSystems.length} known stations to update`);

    // ── Visit each station ──
    for (const target of stationSystems) {
      if (bot.state !== "running") break;

      // Re-check mode
      const mc = getExplorerSettings(bot.username);
      if (mc.mode !== "trade_update") {
        ctx.log("system", "Mode changed — stopping trade update loop");
        break;
      }

      // Skip if recently updated (< 15 mins)
      const freshCheck = mapStore.minutesSinceExplored(target.systemId, target.stationPoi);
      if (freshCheck < 15) {
        continue;
      }

      // ── Navigate to target system if needed ──
      yield "fuel_check";
      const fueled = await ensureFueled(ctx, FUEL_SAFETY_PCT);
      if (!fueled) {
        ctx.log("error", "Cannot refuel — waiting 30s...");
        await sleep(30000);
        continue;
      }

      if (target.systemId !== bot.system) {
        yield "navigate";
        await ensureUndocked(ctx);
        const arrived = await navigateToSystem(ctx, target.systemId, { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30 });
        if (!arrived) {
          ctx.log("error", `Could not reach ${target.systemName} — skipping`);
          continue;
        }
      }

      if (bot.state !== "running") break;

      // ── Travel to station POI ──
      yield "travel_to_station";
      await ensureUndocked(ctx);
      const tResp = await bot.exec("travel", { target_poi: target.stationPoi });
      if (tResp.error && !tResp.error.message.includes("already")) {
        ctx.log("error", `Travel failed: ${tResp.error.message}`);
        continue;
      }
      bot.poi = target.stationPoi;

      // ── Scavenge wrecks en route ──
      yield "scavenge";
      await scavengeWrecks(ctx);

      // ── Dock and scan ──
      yield "scan_station";
      const sysPois = (await getSystemInfo(ctx)).pois;
      const stPoi = sysPois.find(p => p.id === target.stationPoi);
      if (stPoi) {
        yield* scanStation(ctx, target.systemId, stPoi);
      } else {
        // POI not found in live data — try docking anyway
        const dResp = await bot.exec("dock");
        if (!dResp.error || dResp.error.message.includes("already")) {
          bot.docked = true;
          await collectFromStorage(ctx);

          const marketResp = await bot.exec("view_market");
          if (marketResp.result && typeof marketResp.result === "object") {
            mapStore.updateMarket(target.systemId, target.stationPoi, marketResp.result as Record<string, unknown>);
          }

          const missResp = await bot.exec("get_missions");
          if (missResp.result && typeof missResp.result === "object") {
            const mData = missResp.result as Record<string, unknown>;
            const missions = (
              Array.isArray(mData) ? mData :
              Array.isArray(mData.missions) ? mData.missions :
              Array.isArray(mData.available) ? mData.available :
              []
            ) as Array<Record<string, unknown>>;
            if (missions.length > 0) mapStore.updateMissions(target.systemId, target.stationPoi, missions);
          }

          await tryRefuel(ctx);
          await bot.exec("undock");
          bot.docked = false;
          mapStore.markExplored(target.systemId, target.stationPoi);
          ctx.log("info", `Updated ${target.stationName} in ${target.systemName}`);
        }
      }

      // ── Deposit cargo if getting full ──
      await bot.refreshStatus();
      if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) {
        yield "deposit_cargo";
        await depositCargoAtHome(ctx, { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30 });
      }

      // ── Check skills ──
      yield "check_skills";
      await bot.checkSkills();

      await bot.refreshStatus();
    }

    await bot.refreshStatus();
    const cycleFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Trade update cycle done — ${stationSystems.length} stations, ${bot.credits} cr, ${cycleFuel}% fuel`);
    await sleep(5000);
  }
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
