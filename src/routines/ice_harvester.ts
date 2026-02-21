import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import {
  isIceFieldPoi,
  findStation,
  parseOreFromMineResult,
  collectFromStorage,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  refuelAtStation,
  factionDonateProfit,
  readSettings,
  scavengeWrecks,
  getSystemInfo,
  sleep,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

type DepositMode = "storage" | "faction" | "sell";

function getIceSettings(username?: string): {
  depositMode: DepositMode;
  depositFallback: DepositMode;
  cargoThreshold: number;
  refuelThreshold: number;
  repairThreshold: number;
  system: string;
  depositBot: string;
  targetIce: string;
} {
  const all = readSettings();
  const m = all.ice_harvester || {};
  const botOverrides = username ? (all[username] || {}) : {};

  function parseDepositMode(val: unknown): DepositMode | null {
    if (val === "faction" || val === "sell" || val === "storage") return val;
    return null;
  }

  return {
    depositMode:
      parseDepositMode(botOverrides.depositMode) ??
      parseDepositMode(m.depositMode) ?? "storage",
    depositFallback:
      parseDepositMode(botOverrides.depositFallback) ??
      parseDepositMode(m.depositFallback) ?? "storage",
    cargoThreshold: (m.cargoThreshold as number) || 80,
    refuelThreshold: (m.refuelThreshold as number) || 50,
    repairThreshold: (m.repairThreshold as number) || 40,
    system: (m.system as string) || "",
    depositBot: (botOverrides.depositBot as string) || (m.depositBot as string) || "",
    targetIce: (botOverrides.targetIce as string) || (m.targetIce as string) || "",
  };
}

// ── Ice Harvester routine ────────────────────────────────────

export const iceHarvesterRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const homeSystem = bot.system;

  while (bot.state === "running") {
    const settings = getIceSettings(bot.username);
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
        ctx.log("error", "Failed to reach target system — harvesting locally instead");
      }
    }

    if (bot.state !== "running") break;

    // ── Find ice field and station in current system ──
    yield "find_ice_field";
    const { pois, systemId } = await getSystemInfo(ctx);
    if (systemId) bot.system = systemId;

    let icePoi: { id: string; name: string } | null = null;
    let stationPoi: { id: string; name: string } | null = null;

    const station = findStation(pois);
    if (station) stationPoi = { id: station.id, name: station.name };

    // Find ice field — prefer one with target ice if set
    if (settings.targetIce) {
      for (const poi of pois) {
        if (isIceFieldPoi(poi.type)) {
          const sysData = mapStore.getSystem(bot.system);
          const storedPoi = sysData?.pois.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === settings.targetIce)) {
            icePoi = { id: poi.id, name: poi.name };
            break;
          }
        }
      }
    }

    // Fallback: any ice field POI
    if (!icePoi) {
      const iceField = pois.find(p => isIceFieldPoi(p.type));
      if (iceField) icePoi = { id: iceField.id, name: iceField.name };
    }

    if (!icePoi) {
      ctx.log("error", "No ice field found in this system — waiting 30s before retry");
      await sleep(30000);
      continue;
    }

    // ── Travel to ice field ──
    yield "travel_to_field";
    const travelResp = await bot.exec("travel", { target_poi: icePoi.id });
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      ctx.log("error", `Travel failed: ${travelResp.error.message}`);
      await sleep(5000);
      continue;
    }
    bot.poi = icePoi.id;

    // ── Scavenge wrecks before harvesting ──
    yield "scavenge";
    await scavengeWrecks(ctx);

    // ── Harvest loop: mine until cargo threshold ──
    yield "harvest_loop";
    let harvestCycles = 0;
    let stopReason = "";
    const iceMinedMap = new Map<string, number>();

    while (bot.state === "running") {
      await bot.refreshStatus();

      const midHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      if (midHull <= 40) { stopReason = `hull critical (${midHull}%)`; break; }

      const midFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (midFuel < safetyOpts.fuelThresholdPct) { stopReason = `fuel low (${midFuel}%)`; break; }

      const mineResp = await bot.exec("mine");

      if (mineResp.error) {
        const msg = mineResp.error.message.toLowerCase();
        if (msg.includes("depleted") || msg.includes("no resources") || msg.includes("no ice") || msg.includes("no minable")) {
          stopReason = "ice field depleted"; break;
        }
        if (msg.includes("cargo") && msg.includes("full")) {
          stopReason = "cargo full"; break;
        }
        if (msg.includes("harvester") || msg.includes("equipment")) {
          ctx.log("error", `Missing ice harvester module: ${mineResp.error.message}`);
          await sleep(30000);
          return;
        }
        ctx.log("error", `Harvest error: ${mineResp.error.message}`);
        break;
      }

      harvestCycles++;

      const { oreId, oreName } = parseOreFromMineResult(mineResp.result);
      if (oreId && bot.poi) {
        mapStore.recordMiningYield(bot.system, bot.poi, { item_id: oreId, name: oreName });
        iceMinedMap.set(oreName, (iceMinedMap.get(oreName) || 0) + 1);
        bot.stats.totalMined++;
      }

      await bot.refreshStatus();
      const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
      if (fillRatio >= cargoThresholdRatio) {
        stopReason = `cargo at ${Math.round(fillRatio * 100)}%`; break;
      }

      yield "harvesting";
    }

    // Harvest summary
    if (harvestCycles > 0) {
      const iceList = [...iceMinedMap.entries()].map(([name, qty]) => `${qty}x ${name}`).join(", ");
      ctx.log("mining", `Harvested ${harvestCycles} cycles (${iceList})${stopReason ? ` — ${stopReason}` : ""}`);
    } else if (stopReason) {
      ctx.log("mining", `Stopped before harvesting — ${stopReason}`);
    }

    if (bot.state !== "running") break;

    // ── Return to home system if we traveled away ──
    if (bot.system !== homeSystem && homeSystem) {
      yield "return_home";
      yield "pre_return_fuel";
      const returnFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!returnFueled && stationPoi) {
        await refuelAtStation(ctx, stationPoi, safetyOpts.fuelThresholdPct);
      }

      const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to return to home system — docking at nearest station");
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

    // ── Collect storage + unload cargo ──
    await collectFromStorage(ctx);
    const creditsBefore = bot.credits;

    yield "unload_cargo";
    const cargoResp = await bot.exec("get_cargo");
    if (cargoResp.result && typeof cargoResp.result === "object") {
      const result = cargoResp.result as Record<string, unknown>;
      const cargoItems = (
        Array.isArray(result) ? result :
        Array.isArray(result.items) ? result.items :
        Array.isArray(result.cargo) ? result.cargo : []
      ) as Array<Record<string, unknown>>;

      const modeLabel: Record<string, string> = {
        storage: "station storage", faction: "faction storage", sell: "market",
      };
      const primaryLabel = settings.depositBot
        ? `${settings.depositBot}'s storage`
        : (modeLabel[settings.depositMode] || "storage");

      const unloadedItems: string[] = [];
      for (const item of cargoItems) {
        const itemId = (item.item_id as string) || "";
        const quantity = (item.quantity as number) || 0;
        if (!itemId || quantity <= 0) continue;
        const displayName = (item.name as string) || itemId;

        if (settings.depositMode === "sell") {
          const sellResp = await bot.exec("sell", { item_id: itemId, quantity });
          if (sellResp.error) {
            await bot.exec("deposit_items", { item_id: itemId, quantity });
          }
        } else if (settings.depositMode === "faction") {
          const fResp = await bot.exec("faction_deposit_items", { item_id: itemId, quantity });
          if (fResp.error) {
            await bot.exec("deposit_items", { item_id: itemId, quantity });
          }
        } else if (settings.depositBot) {
          const gResp = await bot.exec("send_gift", { recipient: settings.depositBot, item_id: itemId, quantity });
          if (gResp.error) {
            await bot.exec("deposit_items", { item_id: itemId, quantity });
          }
        } else {
          await bot.exec("deposit_items", { item_id: itemId, quantity });
        }
        unloadedItems.push(`${quantity}x ${displayName}`);
        yield "unloading";
      }

      if (unloadedItems.length > 0) {
        ctx.log("trade", `Unloaded ${unloadedItems.join(", ")} → ${primaryLabel}`);
      }
    }

    await bot.refreshStatus();
    await bot.refreshStorage();

    const earnings = bot.credits - creditsBefore;
    await factionDonateProfit(ctx, earnings);

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
  }
};
