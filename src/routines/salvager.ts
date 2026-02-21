import type { Routine, RoutineContext } from "../bot.js";
import {
  isMinablePoi,
  isStationPoi,
  isScenicPoi,
  findStation,
  collectFromStorage,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  factionDonateProfit,
  readSettings,
  scavengeWrecks,
  getSystemInfo,
  sleep,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

type DepositMode = "storage" | "faction" | "sell";

function getSalvagerSettings(username?: string): {
  depositMode: DepositMode;
  cargoThreshold: number;
  refuelThreshold: number;
  repairThreshold: number;
  system: string;
} {
  const all = readSettings();
  const m = all.salvager || {};
  const botOverrides = username ? (all[username] || {}) : {};

  function parseDepositMode(val: unknown): DepositMode | null {
    if (val === "faction" || val === "sell" || val === "storage") return val;
    return null;
  }

  return {
    depositMode:
      parseDepositMode(botOverrides.depositMode) ??
      parseDepositMode(m.depositMode) ?? "sell",
    cargoThreshold: (m.cargoThreshold as number) || 80,
    refuelThreshold: (m.refuelThreshold as number) || 50,
    repairThreshold: (m.repairThreshold as number) || 40,
    system: (m.system as string) || "",
  };
}

// ── Salvager routine ─────────────────────────────────────────

/**
 * Salvager routine — travels POI to POI scavenging wrecks:
 *
 * 1. Undock, get system info
 * 2. Visit each minable POI (belts, clouds, fields) looking for wrecks
 * 3. Loot and salvage wrecks at each location
 * 4. When cargo full or all POIs visited, return to station and sell
 * 5. Refuel, repair, repeat
 */
export const salvagerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const homeSystem = bot.system;

  while (bot.state === "running") {
    const settings = getSalvagerSettings(bot.username);
    const cargoThresholdRatio = settings.cargoThreshold / 100;
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };

    // ── Status + fuel/hull checks ──
    yield "get_status";
    await bot.refreshStatus();

    yield "fuel_check";
    const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
    if (!fueled) {
      ctx.log("error", "Cannot refuel — waiting 30s...");
      await sleep(30000);
      continue;
    }

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= 40) {
      ctx.log("system", `Hull critical (${hullPct}%) — returning to station for repair`);
      await ensureDocked(ctx);
      await repairShip(ctx);
    }

    await ensureUndocked(ctx);

    // ── Navigate to target system if configured ──
    const targetSystemId = settings.system || "";
    if (targetSystemId && targetSystemId !== bot.system) {
      yield "navigate_to_target";
      const arrived = await navigateToSystem(ctx, targetSystemId, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to reach target system — salvaging locally instead");
      }
    }

    if (bot.state !== "running") break;

    // ── Get system POIs ──
    yield "scan_system";
    const { pois, systemId } = await getSystemInfo(ctx);
    if (systemId) bot.system = systemId;

    let stationPoi: { id: string; name: string } | null = null;
    const station = findStation(pois);
    if (station) stationPoi = { id: station.id, name: station.name };

    // Build list of POIs to visit (all non-station, non-scenic)
    const visitPois = pois.filter(p =>
      !isStationPoi(p) && !isScenicPoi(p.type)
    );

    if (visitPois.length === 0) {
      ctx.log("error", "No salvageable POIs in this system — waiting 60s");
      await sleep(60000);
      continue;
    }

    ctx.log("scavenge", `Found ${visitPois.length} POIs to scan for wrecks`);

    // ── Visit each POI and scavenge ──
    let totalLooted = 0;
    let cargoFull = false;

    for (const poi of visitPois) {
      if (bot.state !== "running") break;

      // Check cargo before traveling
      await bot.refreshStatus();
      const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
      if (fillRatio >= cargoThresholdRatio) {
        ctx.log("scavenge", `Cargo at ${Math.round(fillRatio * 100)}% — heading to station`);
        cargoFull = true;
        break;
      }

      // Check fuel
      const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (fuelPct < safetyOpts.fuelThresholdPct) {
        ctx.log("scavenge", `Fuel low (${fuelPct}%) — heading to station`);
        break;
      }

      // Travel to POI
      yield "travel_to_poi";
      ctx.log("travel", `Traveling to ${poi.name}...`);
      const travelResp = await bot.exec("travel", { target_poi: poi.id });
      if (travelResp.error && !travelResp.error.message.includes("already")) {
        ctx.log("error", `Travel to ${poi.name} failed: ${travelResp.error.message}`);
        continue;
      }
      bot.poi = poi.id;

      // Scavenge wrecks at this POI
      yield "scavenge";
      const looted = await scavengeWrecks(ctx);
      totalLooted += looted;

      if (looted > 0) {
        ctx.log("scavenge", `Looted ${looted} items at ${poi.name}`);
      }
    }

    if (bot.state !== "running") break;

    ctx.log("scavenge", `Salvage sweep done — ${totalLooted} items looted across ${visitPois.length} POIs`);

    // ── Return to home system if needed ──
    if (bot.system !== homeSystem && homeSystem) {
      yield "return_home";
      const returnFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (returnFueled) {
        const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
        if (!arrived) {
          ctx.log("error", "Failed to return home — docking at nearest station");
        }
      }
      const { pois: homePois } = await getSystemInfo(ctx);
      const homeStation = findStation(homePois);
      stationPoi = homeStation ? { id: homeStation.id, name: homeStation.name } : null;
    }

    // ── Travel to station ──
    yield "travel_to_station";
    if (stationPoi) {
      const travelStationResp = await bot.exec("travel", { target_poi: stationPoi.id });
      if (travelStationResp.error && !travelStationResp.error.message.includes("already")) {
        ctx.log("error", `Travel to station failed: ${travelStationResp.error.message}`);
      }
    }

    // ── Dock ──
    yield "dock";
    const dockResp = await bot.exec("dock");
    if (dockResp.error && !dockResp.error.message.includes("already")) {
      ctx.log("error", `Dock failed: ${dockResp.error.message}`);
      await sleep(5000);
      continue;
    }
    bot.docked = true;

    // ── Collect storage + sell/deposit cargo ──
    await collectFromStorage(ctx);
    const creditsBefore = bot.credits;

    yield "unload_cargo";
    await bot.refreshCargo();
    const unloadedItems: string[] = [];
    for (const item of bot.inventory) {
      if (!item.itemId || item.quantity <= 0) continue;

      // Skip fuel cells — keep them
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) continue;

      if (settings.depositMode === "sell") {
        const sellResp = await bot.exec("sell", { item_id: item.itemId, quantity: item.quantity });
        if (sellResp.error) {
          await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        }
      } else if (settings.depositMode === "faction") {
        const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
        if (fResp.error) {
          await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        }
      } else {
        await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
      }
      unloadedItems.push(`${item.quantity}x ${item.name}`);
      yield "unloading";
    }

    if (unloadedItems.length > 0) {
      const label = settings.depositMode === "sell" ? "market" : settings.depositMode === "faction" ? "faction" : "storage";
      ctx.log("trade", `Unloaded ${unloadedItems.join(", ")} → ${label}`);
    }

    await bot.refreshStatus();

    const earnings = bot.credits - creditsBefore;
    if (earnings > 0) {
      ctx.log("trade", `Earned ${earnings}cr from salvage`);
      await factionDonateProfit(ctx, earnings);
    }

    // ── Refuel + Repair ──
    yield "refuel";
    await tryRefuel(ctx);
    yield "repair";
    await repairShip(ctx);

    yield "check_skills";
    await bot.checkSkills();

    await bot.refreshStatus();
    const endFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Cycle done — ${bot.credits} credits, ${endFuel}% fuel, ${bot.cargo}/${bot.cargoMax} cargo`);

    // If nothing was found, wait longer before next sweep
    if (totalLooted === 0) {
      ctx.log("scavenge", "No wrecks found — waiting 60s before next sweep");
      await sleep(60000);
    }
  }
};
