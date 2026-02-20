import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import {
  type SystemPOI,
  isMinablePoi,
  isStationPoi,
  findStation,
  parseSystemData,
  getSystemInfo,
  parseOreFromMineResult,
  collectFromStorage,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  refuelAtStation,
  readSettings,
  scavengeWrecks,
  sleep,
  logStatus,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

/** Read miner settings from data/settings.json.
 *  If username is provided, per-bot targetOre override is checked first. */
function getMinerSettings(username?: string): {
  depositMode: "storage" | "faction" | "sell";
  cargoThreshold: number;
  refuelThreshold: number;
  repairThreshold: number;
  system: string;
  depositBot: string;
  targetOre: string;
} {
  const all = readSettings();
  const m = all.miner || {};
  const botOverrides = username ? (all[username] || {}) : {};

  // depositMode: new field, falls back to sellOre boolean for backward compat
  let depositMode: "storage" | "faction" | "sell" = "storage";
  if (m.depositMode === "faction" || m.depositMode === "sell" || m.depositMode === "storage") {
    depositMode = m.depositMode as "storage" | "faction" | "sell";
  } else if (m.sellOre === true) {
    depositMode = "sell";
  }

  return {
    depositMode,
    cargoThreshold: (m.cargoThreshold as number) || 80,
    refuelThreshold: (m.refuelThreshold as number) || 50,
    repairThreshold: (m.repairThreshold as number) || 40,
    system: (m.system as string) || "",
    depositBot: (m.depositBot as string) || "",
    targetOre: (botOverrides.targetOre as string) || (m.targetOre as string) || "",
  };
}

// ── Mission helpers ───────────────────────────────────────────

const MINING_MISSION_KEYWORDS = ["mine", "ore", "mineral", "supply", "collect", "gather", "extract", "asteroid"];

/**
 * Accept available mining/supply missions at the current station.
 * Respects the 5-mission cap. Non-mining missions are skipped.
 */
async function checkAndAcceptMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  // Check how many active missions we already have
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
    Array.isArray(r.missions) ? r.missions :
    []
  ) as Array<Record<string, unknown>>;

  for (const mission of available) {
    if (activeCount >= 5) break;

    const missionId = (mission.id as string) || (mission.mission_id as string) || "";
    if (!missionId) continue;

    const name = ((mission.name as string) || "").toLowerCase();
    const desc = ((mission.description as string) || "").toLowerCase();
    const type = ((mission.type as string) || "").toLowerCase();

    const isMiningMission = MINING_MISSION_KEYWORDS.some(kw =>
      name.includes(kw) || desc.includes(kw) || type.includes(kw)
    );
    if (!isMiningMission) continue;

    const acceptResp = await bot.exec("accept_mission", { mission_id: missionId });
    if (!acceptResp.error) {
      activeCount++;
      ctx.log("info", `Mission accepted: ${(mission.name as string) || missionId} (${activeCount}/5 active)`);
    }
  }
}

/**
 * Attempt to complete any active missions while docked.
 * Called before unloading cargo so mission items are still present.
 * The server will silently reject missions whose conditions aren't met.
 */
async function completeActiveMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  const activeResp = await bot.exec("get_active_missions");
  if (!activeResp.result || typeof activeResp.result !== "object") return;

  const r = activeResp.result as Record<string, unknown>;
  const missions = (
    Array.isArray(r) ? r :
    Array.isArray(r.missions) ? r.missions :
    []
  ) as Array<Record<string, unknown>>;

  if (missions.length === 0) return;

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

/**
 * Check if the current POI's resources are heavily depleted.
 * Returns true if the belt is not worth mining.
 */
async function isBeltDepleted(ctx: RoutineContext): Promise<boolean> {
  const poiResp = await ctx.bot.exec("get_poi");
  if (!poiResp.result || typeof poiResp.result !== "object") return false;

  const r = poiResp.result as Record<string, unknown>;
  const resources = (
    Array.isArray(r.resources) ? r.resources :
    Array.isArray(r.asteroids) ? r.asteroids :
    Array.isArray(r.ores) ? r.ores :
    []
  ) as Array<Record<string, unknown>>;

  if (resources.length === 0) return false; // unknown state — assume fine

  const depletedCount = resources.filter(res => {
    const depletion = (res.depletion_percent as number) ?? 0;
    const remaining = (res.remaining as number) ?? Infinity;
    return depletion >= 90 || remaining === 0;
  }).length;

  return depletedCount === resources.length;
}

// ── Miner routine ────────────────────────────────────────────

/**
 * Miner routine — supports targeted ore seeking across systems:
 *
 * If targetOre is set:
 *   1. Look up ore locations in mapStore
 *   2. Navigate to best belt (cross-system jumps if needed)
 *   3. Mine target ore until cargo full
 *   4. Navigate back to home station
 *   5. Complete missions, sell/deposit, refuel, repair
 *
 * If no targetOre:
 *   Mine at nearest belt in current/configured system
 */
export const minerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const homeSystem = bot.system;

  while (bot.state === "running") {
    // Re-read settings each cycle so changes take effect without restart
    const settings = getMinerSettings(bot.username);
    const cargoThresholdRatio = settings.cargoThreshold / 100;
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };
    const targetOre = settings.targetOre;
    const miningSystem = settings.system || "";

    // ── Status + fuel/hull checks ──
    yield "get_status";
    await bot.refreshStatus();
    logStatus(ctx);

    // Ensure fuel before doing anything
    yield "fuel_check";
    const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
    if (!fueled) {
      ctx.log("error", "Cannot refuel — waiting 30s...");
      await sleep(30000);
      continue;
    }

    // Hull check — repair immediately if low
    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= 40) {
      ctx.log("system", `Hull critical (${hullPct}%) — returning to station for repair`);
      await ensureDocked(ctx);
      await repairShip(ctx);
    }

    // ── Undock if docked ──
    await ensureUndocked(ctx);

    // ── Determine mining destination ──
    yield "find_destination";
    let targetSystemId = "";
    let targetBeltId = "";
    let targetBeltName = "";

    if (targetOre) {
      const oreLocations = mapStore.findOreLocations(targetOre);
      if (oreLocations.length === 0) {
        ctx.log("error", `Target ore "${targetOre}" not found on map. Run an Explorer to discover ore locations first.`);
        ctx.log("info", "Falling back to local mining...");
      } else {
        const inCurrentSystem = oreLocations.find(loc => loc.systemId === bot.system);
        if (inCurrentSystem) {
          targetSystemId = inCurrentSystem.systemId;
          targetBeltId = inCurrentSystem.poiId;
          targetBeltName = inCurrentSystem.poiName;
          ctx.log("mining", `Target ore "${targetOre}" found locally at ${targetBeltName}`);
        } else {
          const withStation = oreLocations.filter(loc => loc.hasStation);
          const best = withStation.length > 0 ? withStation[0] : oreLocations[0];

          const route = mapStore.findRoute(bot.system, best.systemId);
          if (route) {
            targetSystemId = best.systemId;
            targetBeltId = best.poiId;
            targetBeltName = best.poiName;
            ctx.log("mining", `Target ore "${targetOre}" found at ${best.poiName} in ${best.systemName} (${route.length - 1} jump${route.length - 1 !== 1 ? "s" : ""})`);
          } else {
            ctx.log("info", `No mapped route to ${best.systemName}, trying game pathfinder...`);
            const routeResp = await bot.exec("find_route", { target_system: best.systemId });
            if (routeResp.result && !routeResp.error) {
              targetSystemId = best.systemId;
              targetBeltId = best.poiId;
              targetBeltName = best.poiName;
              ctx.log("mining", `Route found to ${best.systemName} via game pathfinder`);
            } else {
              ctx.log("error", `Cannot find route to ${best.systemName} — falling back to local mining`);
            }
          }
        }
      }
    }

    if (!targetSystemId && miningSystem && miningSystem !== bot.system) {
      targetSystemId = miningSystem;
      ctx.log("info", `Configured to mine in ${miningSystem}`);
    }

    // ── Navigate to target system if needed ──
    if (targetSystemId && targetSystemId !== bot.system) {
      yield "navigate_to_target";
      const arrived = await navigateToSystem(ctx, targetSystemId, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to reach target system — mining locally instead");
        targetBeltId = "";
        targetBeltName = "";
      }
    }

    if (bot.state !== "running") break;

    // ── Find asteroid belt and station in current system ──
    yield "find_belt";
    const { pois, systemId } = await getSystemInfo(ctx);
    if (systemId) bot.system = systemId;

    let beltPoi: { id: string; name: string } | null = null;
    let stationPoi: { id: string; name: string } | null = null;

    const station = findStation(pois);
    if (station) stationPoi = { id: station.id, name: station.name };

    // If targeting a specific belt, prefer it
    if (targetBeltId) {
      const match = pois.find(p => p.id === targetBeltId);
      if (match) beltPoi = { id: match.id, name: match.name };
    }

    // Fallback: find belt with target ore
    if (!beltPoi && targetOre) {
      for (const poi of pois) {
        if (isMinablePoi(poi.type)) {
          const sysData = mapStore.getSystem(bot.system);
          const storedPoi = sysData?.pois.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === targetOre)) {
            beltPoi = { id: poi.id, name: poi.name };
            break;
          }
        }
      }
    }

    // Fallback: any minable POI
    if (!beltPoi) {
      const minable = pois.find(p => isMinablePoi(p.type));
      if (minable) beltPoi = { id: minable.id, name: minable.name };
    }

    if (!beltPoi) {
      ctx.log("error", "No minable POI found in this system — waiting 30s before retry");
      await sleep(30000);
      continue;
    }

    ctx.log("info", `Belt: ${beltPoi.name} (${beltPoi.id}) | Station: ${stationPoi?.name || "unknown"}`);

    // ── Travel to asteroid belt ──
    yield "travel_to_belt";
    ctx.log("travel", `Traveling to ${beltPoi.name}...`);
    const travelBeltResp = await bot.exec("travel", { target_poi: beltPoi.id });
    if (travelBeltResp.error && !travelBeltResp.error.message.includes("already")) {
      ctx.log("error", `Travel failed: ${travelBeltResp.error.message}`);
      await sleep(5000);
      continue;
    }
    bot.poi = beltPoi.id;

    // ── Check belt depletion — switch to an alternative if exhausted ──
    yield "check_belt";
    if (await isBeltDepleted(ctx)) {
      ctx.log("mining", `Belt ${beltPoi.name} is depleted — looking for an alternative`);
      const altBelt = pois.find(p => isMinablePoi(p.type) && p.id !== beltPoi!.id);
      if (altBelt) {
        ctx.log("mining", `Switching to ${altBelt.name}`);
        const altTravel = await bot.exec("travel", { target_poi: altBelt.id });
        if (!altTravel.error || altTravel.error.message.includes("already")) {
          beltPoi = { id: altBelt.id, name: altBelt.name };
          bot.poi = altBelt.id;
        }
      } else {
        ctx.log("mining", "No alternative belt found — will mine what remains");
      }
    }

    // ── Scavenge wrecks at belt before mining ──
    yield "scavenge";
    await scavengeWrecks(ctx);

    // ── Mine loop: mine until cargo threshold ──
    yield "mine_loop";
    let miningCycles = 0;
    while (bot.state === "running") {
      await bot.refreshStatus();

      // Safety: hull mid-mining — return to station immediately if <= 40%
      const midHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      if (midHull <= 40) {
        ctx.log("system", `Hull critical (${midHull}%) — returning to station for repair`);
        break;
      }

      // Safety: fuel mid-mining — break if below threshold
      const midFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (midFuel < safetyOpts.fuelThresholdPct) {
        ctx.log("system", `Fuel low (${midFuel}%) — heading to station to refuel`);
        break;
      }

      ctx.log("mining", `Mining... (cycle ${miningCycles + 1})`);
      const mineResp = await bot.exec("mine");

      if (mineResp.error) {
        const msg = mineResp.error.message.toLowerCase();
        if (msg.includes("no asteroids") || msg.includes("depleted") || msg.includes("no minable")) {
          ctx.log("mining", "Belt depleted — moving on");
          break;
        }
        if (msg.includes("cargo") && msg.includes("full")) {
          ctx.log("mining", "Cargo full");
          break;
        }
        ctx.log("error", `Mine error: ${mineResp.error.message}`);
        break;
      }

      miningCycles++;

      // Record ore yield in galaxy map
      const { oreId, oreName } = parseOreFromMineResult(mineResp.result);
      if (oreId && bot.poi) {
        mapStore.recordMiningYield(bot.system, bot.poi, { item_id: oreId, name: oreName });
      }

      await bot.refreshStatus();
      const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
      ctx.log("mining", `Cargo: ${bot.cargo}/${bot.cargoMax} (${Math.round(fillRatio * 100)}%)`);

      if (fillRatio >= cargoThresholdRatio) {
        ctx.log("mining", `Cargo at ${Math.round(fillRatio * 100)}% — heading to station`);
        break;
      }

      yield "mining";
    }

    if (bot.state !== "running") break;

    // ── Return to home system if we traveled away ──
    if (targetOre && bot.system !== homeSystem && homeSystem) {
      yield "return_home";
      ctx.log("travel", `Returning to home system ${homeSystem}...`);

      // Ensure fueled before the journey home
      yield "pre_return_fuel";
      const returnFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!returnFueled && stationPoi) {
        await refuelAtStation(ctx, stationPoi, safetyOpts.fuelThresholdPct);
      }

      const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to return to home system — docking at nearest station");
      }

      // Re-find station in current system
      const { pois: homePois } = await getSystemInfo(ctx);
      const homeStation = findStation(homePois);
      stationPoi = homeStation ? { id: homeStation.id, name: homeStation.name } : null;
    }

    // ── Travel to station ──
    yield "travel_to_station";
    if (stationPoi) {
      ctx.log("travel", `Traveling to ${stationPoi.name}...`);
      const travelStationResp = await bot.exec("travel", { target_poi: stationPoi.id });
      if (travelStationResp.error && !travelStationResp.error.message.includes("already")) {
        ctx.log("error", `Travel to station failed: ${travelStationResp.error.message}`);
      }
    } else {
      ctx.log("travel", "No station found — trying to dock at current location");
    }

    // ── Dock ──
    yield "dock";
    ctx.log("system", "Docking...");
    const dockResp = await bot.exec("dock");
    if (dockResp.error && !dockResp.error.message.includes("already")) {
      ctx.log("error", `Dock failed: ${dockResp.error.message}`);
      await sleep(5000);
      continue;
    }
    bot.docked = true;

    // ── Collect gifted credits/items + record market prices ──
    await collectFromStorage(ctx);

    // ── Complete active missions before unloading (while cargo is still intact) ──
    yield "complete_missions";
    await completeActiveMissions(ctx);

    // ── Sell or Deposit cargo ──
    yield "unload_cargo";
    const cargoResp = await bot.exec("get_cargo");
    if (cargoResp.result && typeof cargoResp.result === "object") {
      const result = cargoResp.result as Record<string, unknown>;
      const cargoItems = (
        Array.isArray(result) ? result :
        Array.isArray(result.items) ? result.items :
        Array.isArray(result.cargo) ? result.cargo :
        []
      ) as Array<Record<string, unknown>>;

      if (settings.depositMode === "sell") {
        ctx.log("trade", "Selling ore at station...");
        for (const item of cargoItems) {
          const itemId = (item.item_id as string) || "";
          const quantity = (item.quantity as number) || 0;
          if (itemId && quantity > 0) {
            const displayName = (item.name as string) || itemId;
            ctx.log("trade", `Selling ${quantity}x ${displayName}...`);
            const sellResp = await bot.exec("sell", { item_id: itemId, quantity });
            if (sellResp.error) {
              ctx.log("trade", `Sell failed for ${displayName}: ${sellResp.error.message} — depositing instead`);
              await bot.exec("deposit_items", { item_id: itemId, quantity });
            }
            yield "selling";
          }
        }
      } else if (settings.depositMode === "faction") {
        ctx.log("trade", "Depositing cargo to faction storage...");
        for (const item of cargoItems) {
          const itemId = (item.item_id as string) || "";
          const quantity = (item.quantity as number) || 0;
          if (itemId && quantity > 0) {
            const displayName = (item.name as string) || itemId;
            ctx.log("trade", `Depositing ${quantity}x ${displayName} to faction...`);
            const factionResp = await bot.exec("faction_deposit_items", { item_id: itemId, quantity });
            if (factionResp.error) {
              ctx.log("trade", `Faction deposit failed for ${displayName}: ${factionResp.error.message} — depositing to personal storage`);
              await bot.exec("deposit_items", { item_id: itemId, quantity });
            }
            yield "depositing";
          }
        }
      } else {
        ctx.log("trade", "Depositing cargo to storage...");
        for (const item of cargoItems) {
          const itemId = (item.item_id as string) || "";
          const quantity = (item.quantity as number) || 0;
          if (itemId && quantity > 0) {
            const displayName = (item.name as string) || itemId;
            ctx.log("trade", `Depositing ${quantity}x ${displayName}...`);
            await bot.exec("deposit_items", { item_id: itemId, quantity });
            yield "depositing";
          }
        }
      }
    }

    // Refresh after unloading
    await bot.refreshStatus();
    await bot.refreshStorage();
    ctx.log("trade", `Credits: ${bot.credits} | Cargo: ${bot.cargo}/${bot.cargoMax}`);

    // ── Accept mining missions for the next cycle ──
    yield "check_missions";
    await checkAndAcceptMissions(ctx);

    // ── Refuel + Repair ──
    yield "refuel";
    await tryRefuel(ctx);
    yield "repair";
    await repairShip(ctx);

    // ── Check for skill level-ups ──
    yield "check_skills";
    await bot.checkSkills();

    ctx.log("info", `=== Mining cycle complete. Credits: ${bot.credits} ===`);
  }
};
