/**
 * Shared utilities for all bot routines.
 *
 * Provides: docking, refueling, repairing, navigation, system parsing,
 * ore parsing, and safety checks.
 */
import type { RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";

// ── Types ────────────────────────────────────────────────────

export interface BaseServices {
  refuel?: boolean;
  repair?: boolean;
  market?: boolean;
  storage?: boolean;
  shipyard?: boolean;
  crafting?: boolean;
  missions?: boolean;
  cloning?: boolean;
  insurance?: boolean;
}

export interface SystemPOI {
  id: string;
  name: string;
  type: string;
  has_base: boolean;
  base_id: string | null;
  /** Station services (refuel, repair, market, etc.) — null if unknown or no base. */
  services: BaseServices | null;
}

export interface Connection {
  id: string;
  name: string;
  /** Fuel cost for this jump. */
  jump_cost: number | null;
}

export interface SystemInfo {
  pois: SystemPOI[];
  connections: Connection[];
  systemId: string;
}

// ── POI classification ───────────────────────────────────────

/** Check if a POI type is a minable resource location (belt, gas cloud, nebula, etc.) */
export function isMinablePoi(type: string): boolean {
  const t = type.toLowerCase();
  return t.includes("asteroid") || t.includes("gas") || t.includes("cloud")
    || t.includes("nebula") || t.includes("field") || t.includes("ring")
    || t.includes("belt") || t.includes("resource");
}

/** Check if a POI type is purely scenic (only needs one visit). */
export function isScenicPoi(type: string): boolean {
  const t = type.toLowerCase();
  return t === "sun" || t === "star" || t === "wormhole" || t === "jump_gate";
}

/** Check if a POI represents a station. */
export function isStationPoi(poi: SystemPOI): boolean {
  return poi.has_base || (poi.type || "").toLowerCase() === "station";
}

/** Find the first station POI in a list. Optionally filter by required service. */
export function findStation(pois: SystemPOI[], requiredService?: keyof BaseServices): SystemPOI | null {
  if (requiredService) {
    // Prefer station with the required service
    const withService = pois.find(p => isStationPoi(p) && p.services?.[requiredService] !== false);
    if (withService) return withService;
  }
  return pois.find(p => isStationPoi(p)) || null;
}

/** Check if a station POI is known to lack a specific service. */
export function stationHasService(poi: SystemPOI, service: keyof BaseServices): boolean {
  // If services are unknown, assume the station has the service (optimistic)
  if (!poi.services) return true;
  return poi.services[service] !== false;
}

// ── System data parsing ──────────────────────────────────────

/** Parse system data from get_system response. Saves to mapStore. */
export function parseSystemData(resp: Record<string, unknown>): SystemInfo {
  const sysObj = resp.system as Record<string, unknown> | undefined;
  const rawPois = (sysObj?.pois ?? resp.pois) as Array<Record<string, unknown>> | undefined;
  const rawConns = (sysObj?.connections ?? sysObj?.jump_gates ?? resp.connections) as Array<Record<string, unknown>> | undefined;
  const systemId = (sysObj?.id as string) || "";

  const pois: SystemPOI[] = [];
  if (Array.isArray(rawPois)) {
    for (const p of rawPois) {
      // Extract base services from inline base object or direct services field
      let services: BaseServices | null = null;
      const baseObj = p.base as Record<string, unknown> | undefined;
      const rawServices = baseObj?.services ?? p.services;
      if (rawServices && typeof rawServices === "object" && !Array.isArray(rawServices)) {
        services = rawServices as BaseServices;
      } else if (Array.isArray(rawServices)) {
        // Convert string array ["refuel", "repair", ...] to services object
        services = {};
        for (const s of rawServices as string[]) {
          (services as Record<string, boolean>)[s] = true;
        }
      }

      pois.push({
        id: (p.id as string) || "",
        name: (p.name as string) || (p.id as string) || "",
        type: (p.type as string) || "",
        has_base: !!(p.has_base || p.base_id || baseObj),
        base_id: (p.base_id as string) || (baseObj?.id as string) || null,
        services,
      });
    }
  }

  const connections: Connection[] = [];
  if (Array.isArray(rawConns)) {
    for (const c of rawConns) {
      const id = (c.system_id as string) || (c.id as string)
        || (c.target_system as string) || (c.target as string)
        || (c.destination as string) || "";
      if (!id) continue;
      connections.push({
        id,
        name: (c.system_name as string) || (c.name as string) || id,
        jump_cost: (c.jump_cost as number) ?? null,
      });
    }
  }

  // Save to mapStore — merge top-level fields in case API puts them outside "system"
  const merged = { ...(sysObj || {}) } as Record<string, unknown>;
  if (!merged.id && resp.id) merged.id = resp.id;
  if (!merged.security_level && resp.security_level) merged.security_level = resp.security_level;
  if (!merged.security_status && resp.security_status) merged.security_status = resp.security_status;

  if (merged.id || sysObj?.id) {
    mapStore.updateSystem(merged);
  }

  return { pois, connections, systemId };
}

/** Fetch and parse system data from the API. Updates bot.system if found. */
export async function getSystemInfo(ctx: RoutineContext): Promise<SystemInfo> {
  const { bot } = ctx;
  const systemResp = await bot.exec("get_system");

  if (systemResp.result && typeof systemResp.result === "object") {
    const info = parseSystemData(systemResp.result as Record<string, unknown>);
    if (info.systemId) bot.system = info.systemId;
    return info;
  }

  return { pois: [], connections: [], systemId: bot.system };
}

// ── Ore parsing ──────────────────────────────────────────────

/** Extract ore id and name from a mine response result. */
export function parseOreFromMineResult(result: unknown): { oreId: string; oreName: string } {
  if (!result || typeof result !== "object") return { oreId: "", oreName: "" };

  const mr = result as Record<string, unknown>;
  const ore = mr.item ?? mr.ore ?? mr.mined;
  let oreId = "";
  let oreName = "";

  if (ore && typeof ore === "object") {
    const oreObj = ore as Record<string, unknown>;
    oreId = (oreObj.item_id as string) || (oreObj.id as string) || (oreObj.name as string) || "";
    oreName = (oreObj.name as string) || oreId;
  } else {
    oreId = (mr.resource_id as string) || (mr.item_id as string) || (mr.ore_id as string) || "";
    oreName = (mr.resource_name as string) || (mr.item_name as string) || (mr.ore_name as string) || (mr.name as string) || oreId;
  }

  return { oreId, oreName };
}

// ── Docking ──────────────────────────────────────────────────

/** Ensure the bot is docked at a station. Finds one in current system,
 *  or navigates to the nearest known station system if none is available.
 *  Returns true if successfully docked. */
export async function ensureDocked(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  if (bot.docked) return true;

  const { pois } = await getSystemInfo(ctx);
  const station = findStation(pois);

  if (station) {
    if (bot.poi !== station.id) {
      ctx.log("travel", `Traveling to ${station.name}...`);
      await bot.exec("travel", { target_poi: station.id });
      bot.poi = station.id;
    }
    ctx.log("system", "Docking...");
    const dockResp = await bot.exec("dock");
    if (!dockResp.error || dockResp.error.message.includes("already")) {
      bot.docked = true;
      await collectFromStorage(ctx);
      return true;
    }
  }

  // No station in current system — find nearest known station
  ctx.log("system", "No station in current system — searching for nearest station...");
  const nearest = mapStore.findNearestStationSystem(bot.system);
  if (!nearest) {
    ctx.log("error", "No known station in mapped systems — cannot dock");
    return false;
  }

  ctx.log("travel", `Nearest station: ${nearest.poiName} in ${nearest.systemId} (${nearest.hops} hops)`);

  // Navigate there
  if (nearest.systemId !== bot.system) {
    await ensureUndocked(ctx);
    const route = mapStore.findRoute(bot.system, nearest.systemId);
    if (route && route.length > 1) {
      for (let i = 1; i < route.length; i++) {
        if (bot.state !== "running") return false;
        ctx.log("travel", `Jumping to ${route[i]} (${i}/${route.length - 1})...`);
        const jumpResp = await bot.exec("jump", { target_system: route[i] });
        if (jumpResp.error) {
          ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
          return false;
        }
      }
    } else {
      const jumpResp = await bot.exec("jump", { target_system: nearest.systemId });
      if (jumpResp.error) {
        ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
        return false;
      }
    }
  }

  // Travel to station POI and dock
  ctx.log("travel", `Traveling to ${nearest.poiName}...`);
  await bot.exec("travel", { target_poi: nearest.poiId });
  bot.poi = nearest.poiId;

  ctx.log("system", "Docking...");
  const dResp = await bot.exec("dock");
  if (!dResp.error || dResp.error.message.includes("already")) {
    bot.docked = true;
    await collectFromStorage(ctx);
    return true;
  }

  ctx.log("error", `Dock failed at ${nearest.poiName}: ${dResp.error?.message}`);
  return false;
}

/** Ensure the bot is undocked. */
export async function ensureUndocked(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  ctx.log("system", "Undocking...");
  const resp = await bot.exec("undock");
  if (!resp.error || resp.error.message.includes("already")) {
    bot.docked = false;
  }
}

// ── Market data recording ────────────────────────────────────

/** Record market prices at the current station to the galaxy map. */
export async function recordMarketData(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked || !bot.poi || !bot.system) return;

  const marketResp = await bot.exec("view_market");
  if (marketResp.result && typeof marketResp.result === "object") {
    mapStore.updateMarket(bot.system, bot.poi, marketResp.result as Record<string, unknown>);
  }
}

// ── Storage collection ───────────────────────────────────────

/**
 * Check station storage for credits and items, withdraw everything useful.
 * Withdraws credits first, then fuel cells / other items if cargo space allows.
 * Also records market prices at the station.
 * Should be called every time a bot successfully docks.
 */
export async function collectFromStorage(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;

  const storageResp = await bot.exec("view_storage");
  if (!storageResp.result || typeof storageResp.result !== "object") return;

  const r = storageResp.result as Record<string, unknown>;

  // Withdraw credits
  const credits = (r.credits as number) || (r.stored_credits as number) || 0;
  if (credits > 0) {
    const wResp = await bot.exec("withdraw_credits", { amount: credits });
    if (!wResp.error) {
      await bot.refreshStatus();
    }
  }

  // Withdraw items (fuel cells first, then others if cargo space allows)
  const storedItems = (
    Array.isArray(r.items) ? (r.items as Array<Record<string, unknown>>) :
    Array.isArray(r.stored_items) ? (r.stored_items as Array<Record<string, unknown>>) :
    Array.isArray(r.inventory) ? (r.inventory as Array<Record<string, unknown>>) :
    []
  );

  if (storedItems.length === 0 && credits <= 0) return;

  const withdrawnItems: string[] = [];

  // Sort: fuel cells first (most urgent)
  const sorted = [...storedItems].sort((a, b) => {
    const aId = ((a.item_id as string) || "").toLowerCase();
    const bId = ((b.item_id as string) || "").toLowerCase();
    const aFuel = aId.includes("fuel") || aId.includes("energy_cell") ? 0 : 1;
    const bFuel = bId.includes("fuel") || bId.includes("energy_cell") ? 0 : 1;
    return aFuel - bFuel;
  });

  await bot.refreshStatus();
  for (const item of sorted) {
    const itemId = (item.item_id as string) || (item.id as string) || "";
    const quantity = (item.quantity as number) || 0;
    if (!itemId || quantity <= 0) continue;

    const isFuel = itemId.toLowerCase().includes("fuel") || itemId.toLowerCase().includes("energy_cell");

    // Check available cargo space
    const freeSpace = bot.cargoMax > 0 ? bot.cargoMax - bot.cargo : Infinity;
    if (freeSpace <= 0 && !isFuel) continue; // cargo full — skip non-fuel
    if (freeSpace <= 0) continue; // even fuel can't fit

    // Limit withdraw quantity to available cargo space
    const withdrawQty = freeSpace < Infinity ? Math.min(quantity, freeSpace) : quantity;
    if (withdrawQty <= 0) continue;

    const displayName = (item.name as string) || itemId;
    const wResp = await bot.exec("withdraw_items", { item_id: itemId, quantity: withdrawQty });
    if (!wResp.error) {
      withdrawnItems.push(`${withdrawQty}x ${displayName}`);
      await bot.refreshStatus();
    }
  }

  // Summary line
  const parts: string[] = [];
  if (credits > 0) parts.push(`${credits} credits`);
  if (withdrawnItems.length > 0) parts.push(withdrawnItems.join(", "));
  if (parts.length > 0) ctx.log("trade", `Collected from storage: ${parts.join(", ")}`);

  await bot.refreshStatus();

  // Record market prices at this station
  await recordMarketData(ctx);
}

// ── Refueling ────────────────────────────────────────────────

/** Sell all cargo to raise credits. Returns number of items sold. */
export async function sellAllCargo(ctx: RoutineContext): Promise<number> {
  const { bot } = ctx;
  await bot.refreshCargo();

  let sold = 0;
  for (const item of bot.inventory) {
    const resp = await bot.exec("sell", { item_id: item.itemId, quantity: item.quantity });
    if (!resp.error) sold++;
  }
  return sold;
}

/**
 * Emergency fuel recovery when stranded (0% fuel, can't travel).
 * Tries: dock where we are → sell cargo → refuel.
 * Last resort: self-destruct to respawn at home station.
 * Returns true if recovered, false if still stuck.
 */
export async function emergencyFuelRecovery(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshStatus();

  const fuelPct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : bot.fuel;
  if (fuelPct > 5) return true; // not actually stranded

  ctx.log("error", "EMERGENCY: Stranded with no fuel — attempting recovery...");

  // First: scavenge nearby wrecks/containers for fuel cells
  if (!bot.docked) {
    ctx.log("scavenge", "Checking for nearby fuel cells or containers...");
    const looted = await scavengeWrecks(ctx);
    if (looted > 0) {
      // Try refueling from cargo (fuel cells)
      ctx.log("system", "Found items — attempting refuel from cargo...");
      const refuelResp = await bot.exec("refuel");
      if (!refuelResp.error) {
        await bot.refreshStatus();
        const newFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : bot.fuel;
        ctx.log("system", `Recovery via scavenge successful! Fuel: ${newFuel}%`);
        return true;
      }
    }
  }

  // Try to dock at current location
  if (!bot.docked) {
    const dockResp = await bot.exec("dock");
    if (!dockResp.error || dockResp.error.message.includes("already")) {
      bot.docked = true;
      ctx.log("system", "Managed to dock — checking storage, selling cargo, refueling...");
      await collectFromStorage(ctx);
      await sellAllCargo(ctx);
      await bot.refreshStatus();
      const refuelResp = await bot.exec("refuel");
      if (!refuelResp.error) {
        await bot.refreshStatus();
        ctx.log("system", `Recovery successful! Fuel: ${bot.fuel}/${bot.maxFuel}`);
        return true;
      }
    }
  }

  // If docked but still can't refuel, sell cargo and try again
  if (bot.docked) {
    await sellAllCargo(ctx);
    await bot.refreshStatus();
    const refuelResp = await bot.exec("refuel");
    if (!refuelResp.error) {
      await bot.refreshStatus();
      ctx.log("system", `Recovery successful! Fuel: ${bot.fuel}/${bot.maxFuel}`);
      return true;
    }

    // Still can't refuel — stay docked and wait (rescue bot may help, or station restocks)
    ctx.log("system", "Cannot refuel — staying docked and waiting for help...");
    for (let w = 0; w < REFUEL_WAIT_RETRIES && bot.state === "running"; w++) {
      await sleep(REFUEL_WAIT_INTERVAL);
      await bot.refreshStatus();
      const fuelNow = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (fuelNow > 5) {
        ctx.log("system", `Fuel recovered to ${fuelNow}% — resuming`);
        return true;
      }
      // Try selling + refueling each cycle
      await sellAllCargo(ctx);
      const retryResp = await bot.exec("refuel");
      if (!retryResp.error) {
        await bot.refreshStatus();
        ctx.log("system", `Refuel succeeded after wait! Fuel: ${bot.fuel}/${bot.maxFuel}`);
        return true;
      }
      ctx.log("system", `Waiting at station for fuel... (${w + 1}/${REFUEL_WAIT_RETRIES})`);
    }
  }

  // Stranded — wait for rescue bot or manual intervention
  ctx.log("error", "Cannot recover fuel — stranded! Waiting for FuelRescue bot or manual help...");
  return false;
}

/** Max retries when waiting at station for fuel. */
const REFUEL_WAIT_RETRIES = 10;
/** Seconds between refuel retries when waiting at station. */
const REFUEL_WAIT_INTERVAL = 30_000;

/** Attempt to refuel to full. Calls refuel repeatedly until tank is full.
 *  If broke, sells cargo. If still can't refuel, waits at station and retries.
 *  Assumes docked. */
export async function tryRefuel(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  await bot.refreshStatus();

  let fuelPct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : bot.fuel;
  if (fuelPct >= 95) return;

  const startFuel = Math.round(fuelPct);

  // Check if current station has refuel service
  const { pois } = await getSystemInfo(ctx);
  const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi);
  if (currentStation?.services && currentStation.services.refuel === false) {
    const refuelStation = findStation(pois, "refuel");
    if (refuelStation && refuelStation.id !== currentStation.id) {
      await bot.exec("undock");
      bot.docked = false;
      await bot.exec("travel", { target_poi: refuelStation.id });
      bot.poi = refuelStation.id;
      const dResp = await bot.exec("dock");
      if (!dResp.error || dResp.error.message.includes("already")) {
        bot.docked = true;
        await collectFromStorage(ctx);
      } else {
        ctx.log("error", `Dock at ${refuelStation.name} failed: ${dResp.error.message}`);
        return;
      }
    }
  }

  // Call refuel repeatedly until full or until it fails
  let consecutiveErrors = 0;
  for (let i = 0; i < 10 && bot.state === "running"; i++) {
    const resp = await bot.exec("refuel");
    if (resp.error) {
      consecutiveErrors++;
      const msg = resp.error.message.toLowerCase();
      if (msg.includes("already full") || msg.includes("tank_full") || msg.includes("max")) {
        break;
      }
      if (msg.includes("credit") || msg.includes("fuel_source") || msg.includes("insufficient")) {
        const sold = await sellAllCargo(ctx);
        if (sold > 0) {
          await bot.refreshStatus();
          continue;
        }
      }
      if (consecutiveErrors >= 2) break;
      continue;
    }

    consecutiveErrors = 0;
    await bot.refreshStatus();
    fuelPct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : bot.fuel;
    if (fuelPct >= 95) break;
  }

  await bot.refreshStatus();
  fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct >= 50) {
    if (fuelPct > startFuel) ctx.log("system", `Refueled ${startFuel}% → ${fuelPct}%`);
    return;
  }

  // Fuel still low — wait at station and retry periodically
  for (let attempt = 1; attempt <= REFUEL_WAIT_RETRIES && bot.state === "running"; attempt++) {
    ctx.log("system", `Fuel still at ${fuelPct}% — waiting at station (attempt ${attempt}/${REFUEL_WAIT_RETRIES})...`);
    await sleep(REFUEL_WAIT_INTERVAL);

    // Retry: sell + refuel
    await sellAllCargo(ctx);
    await bot.exec("refuel");
    await bot.refreshStatus();
    fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (fuelPct >= 50) {
      ctx.log("system", `Fuel recovered to ${fuelPct}% — continuing`);
      return;
    }
  }

  await bot.refreshStatus();
  ctx.log("error", `Could not refuel after ${REFUEL_WAIT_RETRIES} waits — fuel: ${bot.fuel}/${bot.maxFuel}`);
}

// ── Repair ───────────────────────────────────────────────────

/** Repair the ship if damaged. Assumes docked. */
export async function repairShip(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  await bot.refreshStatus();
  const hullPct = bot.maxHull > 0 ? (bot.hull / bot.maxHull) * 100 : 100;
  if (hullPct < 95) {
    const startHull = Math.round(hullPct);

    // Check if current station has repair service
    const { pois } = await getSystemInfo(ctx);
    const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi);
    if (currentStation?.services && currentStation.services.repair === false) {
      const repairStation = findStation(pois, "repair");
      if (repairStation && repairStation.id !== currentStation.id) {
        await bot.exec("undock");
        bot.docked = false;
        await bot.exec("travel", { target_poi: repairStation.id });
        bot.poi = repairStation.id;
        const dResp = await bot.exec("dock");
        if (!dResp.error || dResp.error.message.includes("already")) {
          bot.docked = true;
          await collectFromStorage(ctx);
        } else {
          ctx.log("error", `Dock at ${repairStation.name} failed: ${dResp.error.message}`);
          return;
        }
      }
    }

    await bot.exec("repair");
    await bot.refreshStatus();
    const endHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (endHull > startHull) ctx.log("system", `Repaired hull ${startHull}% → ${endHull}%`);
  }
}

// ── Safety checks ────────────────────────────────────────────

/** Check fuel and hull, dock/refuel/repair if below thresholds.
 *  Uses ensureFueled() for robust cross-system fuel recovery. */
export async function safetyCheck(
  ctx: RoutineContext,
  opts: { fuelThresholdPct: number; hullThresholdPct: number },
): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshStatus();

  const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
  if (hullPct <= 40) {
    ctx.log("system", `Hull critical (${hullPct}%) — finding station for repair`);
    const docked = await ensureDocked(ctx);
    if (docked) {
      await repairShip(ctx);
    }
  }

  const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct < opts.fuelThresholdPct) {
    const ok = await ensureFueled(ctx, opts.fuelThresholdPct);
    if (!ok) return false;
  }
  return true;
}

/**
 * Ensure the bot has adequate fuel. If below threshold:
 * 1. Try to refuel at a station in the current system (dock + credit refuel)
 * 2. If no local station, try using fuel cells already in cargo
 * 3. If fuel is at 1 or less and no station reachable, jettison cheap cargo to make room,
 *    then scavenge nearby wrecks for fuel cells
 * 4. If no local station, find the nearest known system with a station and navigate there
 * Returns true if fuel is now adequate, false if stranded.
 */
export async function ensureFueled(
  ctx: RoutineContext,
  thresholdPct: number,
): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshStatus();
  let fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct >= thresholdPct) return true;

  ctx.log("system", `Fuel low (${fuelPct}%) — need to refuel (threshold: ${thresholdPct}%)...`);

  // Step 1: Try local station first — dock and refuel with credits, no cargo loss
  const { pois } = await getSystemInfo(ctx);
  const localStation = findStation(pois);

  if (localStation) {
    ctx.log("system", `Station found in current system: ${localStation.name}`);
    const ok = await refuelAtStation(ctx, localStation, thresholdPct);
    if (ok) return true;
    // refuelAtStation failed — try emergency
    return await emergencyFuelRecovery(ctx);
  }

  // Step 2: No local station — try fuel cells already in cargo
  if (!bot.docked) {
    const refuelResp = await bot.exec("refuel");
    if (!refuelResp.error) {
      await bot.refreshStatus();
      fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (fuelPct >= thresholdPct) {
        ctx.log("system", `Refueled from cargo fuel cells — fuel now ${fuelPct}%`);
        return true;
      }
    }

    // Step 3: Nearly out of fuel — jettison cargo to make room and scavenge fuel cells.
    // Only do this when fuel is at 1 or less; with more fuel the bot can navigate to a station.
    if (bot.fuel <= 1) {
      const cargoResp = await bot.exec("get_cargo");
      if (cargoResp.result && typeof cargoResp.result === "object") {
        const cResult = cargoResp.result as Record<string, unknown>;
        const cargoItems = (
          Array.isArray(cResult) ? cResult :
          Array.isArray(cResult.items) ? (cResult.items as Array<Record<string, unknown>>) :
          Array.isArray(cResult.cargo) ? (cResult.cargo as Array<Record<string, unknown>>) :
          []
        ).filter((item: Record<string, unknown>) => {
          const itemId = ((item.item_id as string) || "").toLowerCase();
          return itemId && !itemId.includes("fuel") && !itemId.includes("energy_cell");
        });

        // Sort: lowest value first, then highest quantity (jettison cheap bulk first)
        cargoItems.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
          const aVal = (a.value as number) ?? (a.price as number) ?? (a.sell_price as number) ?? 0;
          const bVal = (b.value as number) ?? (b.price as number) ?? (b.sell_price as number) ?? 0;
          if (aVal !== bVal) return aVal - bVal; // lowest value first
          const aQty = (a.quantity as number) || 0;
          const bQty = (b.quantity as number) || 0;
          return bQty - aQty; // highest quantity first
        });

        for (const item of cargoItems) {
          const itemId = (item.item_id as string) || "";
          const quantity = (item.quantity as number) || 0;
          if (!itemId || quantity <= 0) continue;
          const displayName = (item.name as string) || itemId;
          ctx.log("system", `Stranded with 0 fuel — jettisoning ${quantity}x ${displayName} to make room for fuel cells...`);
          await bot.exec("jettison", { item_id: itemId, quantity });
        }
      }
    }

    const looted = await scavengeWrecks(ctx, { fuelOnly: true });
    if (looted > 0) {
      const scavRefuelResp = await bot.exec("refuel");
      if (!scavRefuelResp.error) {
        await bot.refreshStatus();
        fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
        if (fuelPct >= thresholdPct) {
          ctx.log("system", `Scavenged fuel cells — fuel now ${fuelPct}%`);
          return true;
        }
      }
    }
  }

  // Step 4: No local station — find nearest known system with one
  ctx.log("system", "No station in current system — searching known map for nearest station...");
  const nearest = mapStore.findNearestStationSystem(bot.system);
  if (!nearest) {
    ctx.log("error", "No known station in mapped systems — emergency recovery...");
    return await emergencyFuelRecovery(ctx);
  }

  ctx.log("travel", `Nearest station: ${nearest.poiName} in ${nearest.systemId} (${nearest.hops} jump${nearest.hops !== 1 ? "s" : ""} away)`);

  // Navigate there — use navigateToSystem if in a different system
  if (nearest.systemId !== bot.system) {
    // Check if we have enough fuel for at least one jump
    await bot.refreshStatus();
    const curFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (curFuel < 10) {
      ctx.log("error", `Fuel too low (${curFuel}%) to reach station — emergency recovery...`);
      return await emergencyFuelRecovery(ctx);
    }

    await ensureUndocked(ctx);

    // Jump system by system toward the station
    const route = mapStore.findRoute(bot.system, nearest.systemId);
    if (route && route.length > 1) {
      for (let i = 1; i < route.length; i++) {
        if (bot.state !== "running") return false;
        await bot.refreshStatus();
        const preFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
        if (preFuel < 10) {
          ctx.log("error", `Fuel critical (${preFuel}%) mid-route — emergency recovery...`);
          return await emergencyFuelRecovery(ctx);
        }
        ctx.log("travel", `Jumping to ${route[i]} (${i}/${route.length - 1})...`);
        const jumpResp = await bot.exec("jump", { target_system: route[i] });
        if (jumpResp.error) {
          ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
          return await emergencyFuelRecovery(ctx);
        }
      }
    } else {
      // Direct jump
      ctx.log("travel", `Direct jump to ${nearest.systemId}...`);
      const jumpResp = await bot.exec("jump", { target_system: nearest.systemId });
      if (jumpResp.error) {
        ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
        return await emergencyFuelRecovery(ctx);
      }
    }
  }

  // Now in the station system — travel, dock, refuel
  await bot.refreshStatus();
  await ensureUndocked(ctx);
  ctx.log("travel", `Traveling to ${nearest.poiName}...`);
  const tResp = await bot.exec("travel", { target_poi: nearest.poiId });
  if (tResp.error && !tResp.error.message.includes("already")) {
    ctx.log("error", `Travel to station failed: ${tResp.error.message}`);
    return await emergencyFuelRecovery(ctx);
  }
  bot.poi = nearest.poiId;

  const dResp = await bot.exec("dock");
  if (!dResp.error || dResp.error.message.includes("already")) {
    bot.docked = true;
    await collectFromStorage(ctx);
  } else {
    ctx.log("error", `Dock failed: ${dResp.error.message}`);
    return await emergencyFuelRecovery(ctx);
  }

  await tryRefuel(ctx);
  await bot.refreshStatus();
  let newFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  ctx.log("system", `Refueled at ${nearest.poiName} — Fuel: ${newFuel}%`);

  // CRITICAL: Do NOT undock until fuel is adequate
  if (newFuel < thresholdPct) {
    ctx.log("system", `Fuel still below threshold (${newFuel}% < ${thresholdPct}%) — staying docked and waiting...`);
    for (let w = 0; w < REFUEL_WAIT_RETRIES && bot.state === "running"; w++) {
      await sleep(REFUEL_WAIT_INTERVAL);
      await bot.refreshStatus();
      await bot.exec("refuel");
      await bot.refreshStatus();
      newFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (newFuel >= thresholdPct) {
        ctx.log("system", `Fuel recovered to ${newFuel}% — resuming`);
        break;
      }
      ctx.log("system", `Still waiting for fuel (${newFuel}%)... (${w + 1}/${REFUEL_WAIT_RETRIES})`);
    }
  }

  await bot.refreshStatus();
  newFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  ctx.log("system", "Undocking...");
  await bot.exec("undock");
  bot.docked = false;
  return newFuel >= 10;
}

// ── Cargo deposit ──────────────────────────────────────────

/** Default home station for depositing cargo. */
const HOME_SYSTEM = "sol";
const HOME_STATION_POI = "sol_station";
const HOME_STATION_NAME = "Sol Central";

/**
 * Navigate to Sol Central and deposit all non-fuel cargo to station storage.
 * Used when cargo is full during exploration. Returns true if deposit succeeded.
 */
export async function depositCargoAtHome(
  ctx: RoutineContext,
  opts: { fuelThresholdPct: number; hullThresholdPct: number } = { fuelThresholdPct: 40, hullThresholdPct: 30 },
): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshStatus();

  ctx.log("trade", `Cargo full (${bot.cargo}/${bot.cargoMax}) — returning to ${HOME_STATION_NAME} to deposit...`);

  // Navigate to Sol if not already there
  if (bot.system !== HOME_SYSTEM) {
    await ensureUndocked(ctx);
    const arrived = await navigateToSystem(ctx, HOME_SYSTEM, opts);
    if (!arrived) {
      ctx.log("error", `Could not reach ${HOME_SYSTEM} — will try depositing at nearest station`);
      // Fallback: dock at any local station
      await ensureDocked(ctx);
      if (!bot.docked) return false;
      return await depositNonFuelCargo(ctx);
    }
  }

  // Travel to Sol Central station
  await ensureUndocked(ctx);
  if (bot.poi !== HOME_STATION_POI) {
    ctx.log("travel", `Traveling to ${HOME_STATION_NAME}...`);
    const tResp = await bot.exec("travel", { target_poi: HOME_STATION_POI });
    if (tResp.error && !tResp.error.message.includes("already")) {
      ctx.log("error", `Travel to ${HOME_STATION_NAME} failed: ${tResp.error.message}`);
      return false;
    }
    bot.poi = HOME_STATION_POI;
  }

  // Dock
  if (!bot.docked) {
    const dResp = await bot.exec("dock");
    if (dResp.error && !dResp.error.message.includes("already")) {
      ctx.log("error", `Dock failed at ${HOME_STATION_NAME}: ${dResp.error.message}`);
      return false;
    }
    bot.docked = true;
  }

  // Collect any gifted credits/items from storage
  await collectFromStorage(ctx);

  // Deposit cargo
  const deposited = await depositNonFuelCargo(ctx);

  // Refuel while we're here
  await tryRefuel(ctx);

  // Undock
  await ensureUndocked(ctx);

  return deposited;
}

/** Deposit all non-fuel cargo to station storage. Assumes docked. Returns true if any items deposited. */
export async function depositNonFuelCargo(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const cargoResp = await bot.exec("get_cargo");
  if (!cargoResp.result || typeof cargoResp.result !== "object") return false;

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
    ctx.log("trade", `Depositing ${quantity}x ${displayName} to storage...`);
    await bot.exec("deposit_items", { item_id: itemId, quantity });
    deposited += quantity;
  }

  if (deposited > 0) {
    ctx.log("trade", `Deposited ${deposited} items at ${HOME_STATION_NAME}`);
    await bot.refreshCargo();
  }
  return deposited > 0;
}

// ── Navigation ───────────────────────────────────────────────

/** Navigate to a target system via jump chain. Returns true if arrived. */
export async function navigateToSystem(
  ctx: RoutineContext,
  targetSystemId: string,
  opts: { fuelThresholdPct: number; hullThresholdPct: number },
): Promise<boolean> {
  const { bot } = ctx;
  const MAX_JUMPS = 20;

  for (let attempt = 0; attempt < MAX_JUMPS; attempt++) {
    await bot.refreshStatus();
    if (bot.system === targetSystemId) return true;

    // Plan route from current position
    const route = mapStore.findRoute(bot.system, targetSystemId);
    let nextSystem: string | null = null;

    if (route && route.length > 1) {
      nextSystem = route[1];
      ctx.log("travel", `Route: ${route.length - 1} jump${route.length - 1 !== 1 ? "s" : ""} remaining`);
    } else {
      ctx.log("travel", `No mapped route — querying server for route to ${targetSystemId}`);
      const routeResp = await bot.exec("find_route", { target_system: targetSystemId });
      const routeData = routeResp.result as { found?: boolean; route?: Array<{ system_id: string; name: string }>; total_jumps?: number } | null;
      if (!routeResp.error && routeData?.found && routeData.route && routeData.route.length > 1) {
        nextSystem = routeData.route[1].system_id;
        ctx.log("travel", `Server route: ${routeData.total_jumps} jump${routeData.total_jumps !== 1 ? "s" : ""} — next: ${nextSystem}`);
      } else {
        ctx.log("error", `No route to ${targetSystemId} — cannot navigate`);
        return false;
      }
    }

    // Hull check — repair immediately if <= 40%
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= 40) {
      ctx.log("system", `Hull critical (${hullPct}%) — finding station for repair`);
      const docked = await ensureDocked(ctx);
      if (docked) {
        await repairShip(ctx);
        await ensureUndocked(ctx);
      } else if (hullPct === 0) {
        ctx.log("error", "Hull at 0% and no station found — cannot continue safely");
        return false;
      }
    }

    // Fuel check — MUST have adequate fuel before jumping
    const fueled = await ensureFueled(ctx, Math.max(opts.fuelThresholdPct, 25));
    if (!fueled) {
      ctx.log("error", "Cannot secure fuel for jump — aborting navigation");
      return false;
    }

    // Re-check in case ensureFueled moved us
    await bot.refreshStatus();
    if (bot.system === targetSystemId) return true;

    await ensureUndocked(ctx);

    // Jump
    ctx.log("travel", `Jumping to ${nextSystem}...`);
    const jumpResp = await bot.exec("jump", { target_system: nextSystem });
    if (jumpResp.error) {
      ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
      return false;
    }

    await bot.refreshStatus();

    // Update map data for the new system
    const sysResp = await bot.exec("get_system");
    if (sysResp.result && typeof sysResp.result === "object") {
      parseSystemData(sysResp.result as Record<string, unknown>);
    }

    ctx.log("travel", `Arrived in ${bot.system}`);
    if (bot.system === targetSystemId) return true;
    if (bot.state !== "running") return false;
  }

  ctx.log("error", `Failed to reach ${targetSystemId} after ${MAX_JUMPS} jumps`);
  return false;
}

/** Refuel at a specific station POI if fuel is below threshold. Handles travel/dock/undock.
 *  Returns true if successfully refueled, false if stranded. */
export async function refuelAtStation(
  ctx: RoutineContext,
  station: { id: string; name: string },
  thresholdPct: number,
): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshStatus();
  const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct >= thresholdPct) return true;

  ctx.log("system", `Fuel low (${fuelPct}%) — refueling at ${station.name}...`);

  if (bot.poi !== station.id) {
    ctx.log("travel", `Traveling to ${station.name} for fuel...`);
    const travelResp = await bot.exec("travel", { target_poi: station.id });
    if (travelResp.error) {
      const msg = travelResp.error.message.toLowerCase();
      if (msg.includes("fuel") || msg.includes("no_fuel")) {
        ctx.log("error", `Can't travel to station — no fuel!`);
        return await emergencyFuelRecovery(ctx);
      }
      ctx.log("error", `Travel to station failed: ${travelResp.error.message}`);
      return false;
    }
    bot.poi = station.id;
  }

  if (!bot.docked) {
    const dockResp = await bot.exec("dock");
    if (dockResp.error && !dockResp.error.message.includes("already")) {
      ctx.log("error", `Dock failed: ${dockResp.error.message}`);
      return await emergencyFuelRecovery(ctx);
    }
    bot.docked = true;
  }

  // Collect any gifted credits/items (may help pay for fuel)
  await collectFromStorage(ctx);

  await tryRefuel(ctx);

  // Verify refuel actually worked — do NOT undock if fuel is dangerously low
  await bot.refreshStatus();
  let newFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (newFuelPct < thresholdPct) {
    ctx.log("system", `Fuel still at ${newFuelPct}% after refuel — waiting at ${station.name}...`);
    for (let w = 0; w < REFUEL_WAIT_RETRIES && bot.state === "running"; w++) {
      await sleep(REFUEL_WAIT_INTERVAL);
      await bot.refreshStatus();
      await bot.exec("refuel");
      await bot.refreshStatus();
      newFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (newFuelPct >= thresholdPct) {
        ctx.log("system", `Fuel recovered to ${newFuelPct}% — resuming`);
        break;
      }
      ctx.log("system", `Still waiting for fuel (${newFuelPct}%)... (${w + 1}/${REFUEL_WAIT_RETRIES})`);
    }
  }

  await bot.refreshStatus();
  newFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (newFuelPct < 10) {
    ctx.log("error", `Fuel critically low (${newFuelPct}%) — staying docked at ${station.name}`);
    return false;
  }

  ctx.log("system", "Undocking...");
  await bot.exec("undock");
  bot.docked = false;
  return true;
}

// ── Security ─────────────────────────────────────────────────

/** Try to fetch security level from get_location and update mapStore. */
export async function fetchSecurityLevel(ctx: RoutineContext, systemId: string): Promise<void> {
  const { bot } = ctx;
  const locResp = await bot.exec("get_location");
  if (!locResp.result || typeof locResp.result !== "object") return;

  const loc = locResp.result as Record<string, unknown>;
  const locSys = loc.system as Record<string, unknown> | undefined;
  const secLevel = (locSys?.security_level as string) || (locSys?.security_status as string)
    || (locSys?.lawfulness as string) || (locSys?.security as string)
    || (loc.security_level as string) || (loc.security_status as string)
    || (loc.security as string);

  if (secLevel) {
    const stored = mapStore.getSystem(systemId);
    if (stored && !stored.security_level) {
      mapStore.updateSystem({ id: systemId, security_level: secLevel } as Record<string, unknown>);
      ctx.log("info", `Security level for ${systemId}: ${secLevel}`);
    }
  }
}

// ── Scavenging ──────────────────────────────────────────────

/** Items worth looting from wrecks (prioritize fuel cells). */
const LOOT_PRIORITY = ["fuel_cell", "fuel", "energy_cell"];

interface WreckItem {
  item_id: string;
  name: string;
  quantity: number;
}

interface Wreck {
  wreck_id: string;
  name: string;
  items: WreckItem[];
}

/** Parse wreck list from get_wrecks response. */
function parseWrecks(result: unknown): Wreck[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const rawList = (
    Array.isArray(r) ? r :
    Array.isArray(r.wrecks) ? r.wrecks :
    Array.isArray(r.containers) ? r.containers :
    []
  ) as Array<Record<string, unknown>>;

  return rawList.map(w => {
    const rawItems = (
      Array.isArray(w.items) ? w.items :
      Array.isArray(w.cargo) ? w.cargo :
      Array.isArray(w.contents) ? w.contents :
      []
    ) as Array<Record<string, unknown>>;

    return {
      wreck_id: (w.wreck_id as string) || (w.id as string) || "",
      name: (w.name as string) || (w.type as string) || "wreck",
      items: rawItems.map(i => ({
        item_id: (i.item_id as string) || (i.id as string) || "",
        name: (i.name as string) || (i.item_id as string) || "",
        quantity: (i.quantity as number) || 1,
      })).filter(i => i.item_id),
    };
  }).filter(w => w.wreck_id);
}

/**
 * Check for wrecks/containers at current POI and loot useful items.
 * Prioritizes fuel cells, then loots everything if cargo space allows.
 * Returns number of items looted.
 */
export async function scavengeWrecks(ctx: RoutineContext, opts?: { fuelOnly?: boolean }): Promise<number> {
  const { bot } = ctx;
  if (bot.docked) return 0; // can't scavenge while docked

  const fuelOnly = opts?.fuelOnly ?? false;

  const wrecksResp = await bot.exec("get_wrecks");
  const wrecks = parseWrecks(wrecksResp.result);
  if (wrecks.length === 0) return 0;

  let totalLooted = 0;
  const lootedItems: string[] = [];

  for (const wreck of wrecks) {
    if (bot.state !== "running") break;

    // Check cargo space
    await bot.refreshStatus();
    if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) {
      ctx.log("scavenge", "Cargo full — stopping scavenge");
      break;
    }

    if (wreck.items.length === 0) {
      continue;
    }

    // Filter to fuel items only when fuelOnly is set
    let candidates = [...wreck.items];
    if (fuelOnly) {
      candidates = candidates.filter(i =>
        LOOT_PRIORITY.some(p => i.item_id.toLowerCase().includes(p))
      );
      if (candidates.length === 0) continue;
    }

    // Sort: fuel cells first, then everything else
    candidates.sort((a, b) => {
      const aPri = LOOT_PRIORITY.some(p => a.item_id.includes(p)) ? 0 : 1;
      const bPri = LOOT_PRIORITY.some(p => b.item_id.includes(p)) ? 0 : 1;
      return aPri - bPri;
    });

    for (const item of candidates) {
      if (bot.state !== "running") break;
      if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) break;

      const lootResp = await bot.exec("loot_wreck", {
        wreck_id: wreck.wreck_id,
        item_id: item.item_id,
        quantity: item.quantity,
      });

      if (lootResp.error) {
        if (lootResp.error.message.toLowerCase().includes("empty") ||
            lootResp.error.message.toLowerCase().includes("not found")) {
          break;
        }
        continue;
      }

      totalLooted++;
      lootedItems.push(`${item.quantity}x ${item.name}`);
    }
  }

  if (totalLooted > 0) {
    await bot.refreshCargo();
    ctx.log("scavenge", `Scavenged ${lootedItems.join(", ")} from ${wrecks.length} wreck(s)`);
  }

  return totalLooted;
}

// ── Settings ─────────────────────────────────────────────────

/** Read settings from data/settings.json. */
export function readSettings(): Record<string, Record<string, unknown>> {
  try {
    const { readFileSync, existsSync } = require("fs");
    const { join } = require("path");
    const file = join(process.cwd(), "data", "settings.json");
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf-8"));
    }
  } catch { /* use defaults */ }
  return {};
}

/** Write settings to data/settings.json. Merges with existing settings. */
export function writeSettings(updates: Record<string, Record<string, unknown>>): void {
  const { writeFileSync, existsSync, mkdirSync, readFileSync } = require("fs");
  const { join } = require("path");
  const dir = join(process.cwd(), "data");
  const file = join(dir, "settings.json");

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let existing: Record<string, Record<string, unknown>> = {};
  try {
    if (existsSync(file)) {
      existing = JSON.parse(readFileSync(file, "utf-8"));
    }
  } catch { /* start fresh */ }

  // Deep merge: update each routine section
  for (const [key, val] of Object.entries(updates)) {
    existing[key] = { ...(existing[key] || {}), ...val };
  }

  writeFileSync(file, JSON.stringify(existing, null, 2) + "\n", "utf-8");
}

// ── Utilities ────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Log a status summary line. */
export function logStatus(ctx: RoutineContext): void {
  const { bot } = ctx;
  const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : bot.fuel;
  const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
  ctx.log("info", `Credits: ${bot.credits} | Fuel: ${fuelPct}% | Hull: ${hullPct}% | Cargo: ${bot.cargo}/${bot.cargoMax} | System: ${bot.system} | Docked: ${bot.docked}`);
}
