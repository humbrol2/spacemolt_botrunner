/**
 * Shared utilities for all bot routines.
 *
 * Provides: docking, refueling, repairing, navigation, system parsing,
 * faction management, ore parsing, and safety checks.
 */
import type { RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";

// ── Types ────────────────────────────────────────────────────

export interface SystemPOI {
  id: string;
  name: string;
  type: string;
  has_base: boolean;
  base_id: string | null;
}

export interface Connection {
  id: string;
  name: string;
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

/** Find the first station POI in a list. */
export function findStation(pois: SystemPOI[]): SystemPOI | null {
  return pois.find(p => isStationPoi(p)) || null;
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
      pois.push({
        id: (p.id as string) || "",
        name: (p.name as string) || (p.id as string) || "",
        type: (p.type as string) || "",
        has_base: !!(p.has_base || p.base_id),
        base_id: (p.base_id as string) || null,
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

/** Ensure the bot is docked at a station. Finds and travels to one if needed. */
export async function ensureDocked(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (bot.docked) return;

  const { pois } = await getSystemInfo(ctx);
  const station = findStation(pois);

  if (station && bot.poi !== station.id) {
    ctx.log("travel", "Traveling to station...");
    await bot.exec("travel", { target_poi: station.id });
    bot.poi = station.id;
  }

  ctx.log("system", "Docking...");
  const dockResp = await bot.exec("dock");
  if (!dockResp.error || dockResp.error.message.includes("already")) {
    bot.docked = true;
    await collectFromStorage(ctx);
  }
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

// ── Storage collection ───────────────────────────────────────

/**
 * Check station storage for credits and items, withdraw everything.
 * Called automatically whenever a bot docks.
 */
export async function collectFromStorage(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;

  // Withdraw credits
  const storageResp = await bot.exec("view_storage");
  if (storageResp.result && typeof storageResp.result === "object") {
    const r = storageResp.result as Record<string, unknown>;
    const credits = (r.credits as number) || (r.stored_credits as number) || 0;
    if (credits > 0) {
      ctx.log("trade", `Found ${credits} credits in storage — withdrawing...`);
      const wResp = await bot.exec("withdraw_credits", { amount: credits });
      if (wResp.error) {
        ctx.log("trade", `Credit withdrawal failed: ${wResp.error.message}`);
      } else {
        ctx.log("trade", `Withdrew ${credits} credits from storage`);
        await bot.refreshStatus();
      }
    }
  }
}

// ── Refueling ────────────────────────────────────────────────

/** Sell all cargo to raise credits. Returns number of items sold. */
export async function sellAllCargo(ctx: RoutineContext): Promise<number> {
  const { bot } = ctx;
  await bot.refreshCargo();

  let sold = 0;
  for (const item of bot.inventory) {
    ctx.log("trade", `Selling ${item.quantity}x ${item.name}...`);
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
      ctx.log("system", "Managed to dock — selling cargo and refueling...");
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
  }

  // Stranded — wait for rescue bot or manual intervention
  ctx.log("error", "Cannot recover fuel — stranded! Waiting for FuelRescue bot or manual help...");
  return false;
}

/** Attempt to refuel. If broke, sells cargo and retries. Assumes docked. */
export async function tryRefuel(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  await bot.refreshStatus();

  const fuelPct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : bot.fuel;
  if (fuelPct >= 95) {
    ctx.log("system", "Fuel OK — skipping refuel");
    return;
  }

  ctx.log("system", `Fuel: ${bot.fuel}/${bot.maxFuel} (${Math.round(fuelPct)}%) — refueling...`);
  const resp = await bot.exec("refuel");

  if (resp.error) {
    const msg = resp.error.message.toLowerCase();
    if (msg.includes("credit") || msg.includes("fuel_source") || msg.includes("insufficient")) {
      ctx.log("system", "Can't afford fuel — selling cargo to raise credits...");
      const sold = await sellAllCargo(ctx);
      if (sold > 0) {
        await bot.refreshStatus();
        ctx.log("system", `Credits after selling: ${bot.credits} — retrying refuel...`);
        const retry = await bot.exec("refuel");
        if (retry.error) {
          ctx.log("error", `Still can't refuel: ${retry.error.message}`);
        }
      } else {
        ctx.log("error", "No cargo to sell — stuck without fuel!");
      }
    }
  }

  await bot.refreshStatus();
  ctx.log("system", `Fuel: ${bot.fuel}/${bot.maxFuel}`);
}

// ── Repair ───────────────────────────────────────────────────

/** Repair the ship if damaged. Assumes docked. */
export async function repairShip(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  await bot.refreshStatus();
  const hullPct = bot.maxHull > 0 ? (bot.hull / bot.maxHull) * 100 : 100;
  if (hullPct < 95) {
    ctx.log("system", `Hull: ${bot.hull}/${bot.maxHull} (${Math.round(hullPct)}%) — repairing...`);
    await bot.exec("repair");
    await bot.refreshStatus();
    ctx.log("system", `Hull after repair: ${bot.hull}/${bot.maxHull}`);
  }
}

// ── Safety checks ────────────────────────────────────────────

/** Check fuel and hull, dock/refuel/repair if below thresholds. */
export async function safetyCheck(
  ctx: RoutineContext,
  opts: { fuelThresholdPct: number; hullThresholdPct: number },
): Promise<void> {
  const { bot } = ctx;
  await bot.refreshStatus();

  const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
  if (hullPct < opts.hullThresholdPct) {
    ctx.log("system", `Hull critical (${hullPct}%) — emergency repair`);
    await ensureDocked(ctx);
    await repairShip(ctx);
  }

  const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct < opts.fuelThresholdPct) {
    ctx.log("system", `Fuel low (${fuelPct}%) — emergency refuel`);
    await ensureDocked(ctx);
    await tryRefuel(ctx);
  }
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
      ctx.log("travel", `No mapped route — attempting direct jump to ${targetSystemId}`);
      nextSystem = targetSystemId;
    }

    // Safety checks before jumping
    await safetyCheck(ctx, opts);

    // Verify fuel is sufficient for jump after safety check
    await bot.refreshStatus();
    const preFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (preFuel < 15) {
      ctx.log("error", `Fuel too low for jump (${preFuel}%) — aborting navigation`);
      const recovered = await emergencyFuelRecovery(ctx);
      if (!recovered) return false;
      // Re-check after recovery
      await bot.refreshStatus();
      if (bot.system === targetSystemId) return true;
    }

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

  await tryRefuel(ctx);

  // Verify refuel actually worked
  await bot.refreshStatus();
  const newFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (newFuelPct < 10) {
    ctx.log("error", `Refuel failed — fuel still at ${newFuelPct}%`);
    return false;
  }

  ctx.log("system", "Undocking...");
  await bot.exec("undock");
  bot.docked = false;
  return true;
}

// ── Faction ──────────────────────────────────────────────────

/** Auto-join a faction if the bot isn't in one. */
export async function joinFactionIfNeeded(ctx: RoutineContext, factionId = "CAST"): Promise<void> {
  const { bot } = ctx;
  const statusResp = await bot.exec("get_status");
  if (!statusResp.result || typeof statusResp.result !== "object") return;

  const r = statusResp.result as Record<string, unknown>;
  const currentFaction = r.faction_id as string | undefined;

  if (!currentFaction) {
    ctx.log("system", `Not in a faction — attempting to join ${factionId}...`);
    const joinResp = await bot.exec("join_faction", { faction_id: factionId });
    if (joinResp.error) {
      ctx.log("system", `Could not join ${factionId}: ${joinResp.error.message}`);
    } else {
      ctx.log("system", `Joined ${factionId} faction!`);
    }
  } else {
    ctx.log("system", `Already in faction: ${currentFaction}`);
  }
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
export async function scavengeWrecks(ctx: RoutineContext): Promise<number> {
  const { bot } = ctx;
  if (bot.docked) return 0; // can't scavenge while docked

  const wrecksResp = await bot.exec("get_wrecks");
  const wrecks = parseWrecks(wrecksResp.result);
  if (wrecks.length === 0) return 0;

  ctx.log("scavenge", `Found ${wrecks.length} wreck(s)/container(s) nearby`);
  let totalLooted = 0;

  for (const wreck of wrecks) {
    if (bot.state !== "running") break;

    // Check cargo space
    await bot.refreshStatus();
    if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) {
      ctx.log("scavenge", "Cargo full — stopping scavenge");
      break;
    }

    if (wreck.items.length === 0) {
      // Try to loot anyway — some wrecks might not list items
      continue;
    }

    // Sort: fuel cells first, then everything else
    const sorted = [...wreck.items].sort((a, b) => {
      const aPri = LOOT_PRIORITY.some(p => a.item_id.includes(p)) ? 0 : 1;
      const bPri = LOOT_PRIORITY.some(p => b.item_id.includes(p)) ? 0 : 1;
      return aPri - bPri;
    });

    for (const item of sorted) {
      if (bot.state !== "running") break;
      if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) break;

      ctx.log("scavenge", `Looting ${item.quantity}x ${item.name} from ${wreck.name}...`);
      const lootResp = await bot.exec("loot_wreck", {
        wreck_id: wreck.wreck_id,
        item_id: item.item_id,
        quantity: item.quantity,
      });

      if (lootResp.error) {
        ctx.log("scavenge", `Loot failed: ${lootResp.error.message}`);
        // If wreck is empty/gone, move to next
        if (lootResp.error.message.toLowerCase().includes("empty") ||
            lootResp.error.message.toLowerCase().includes("not found")) {
          break;
        }
        continue;
      }

      totalLooted++;
      ctx.log("scavenge", `Looted ${item.quantity}x ${item.name}`);
    }
  }

  if (totalLooted > 0) {
    await bot.refreshCargo();
    ctx.log("scavenge", `Scavenging complete — ${totalLooted} item(s) collected`);
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
