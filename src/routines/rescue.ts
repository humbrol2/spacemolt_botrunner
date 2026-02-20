import type { Routine, RoutineContext, BotStatus } from "../bot.js";
import {
  findStation,
  getSystemInfo,
  collectFromStorage,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  ensureFueled,
  navigateToSystem,
  scavengeWrecks,
  readSettings,
  sleep,
  logStatus,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

function getRescueSettings(): {
  fuelThreshold: number;
  rescueFuelCells: number;
  rescueCredits: number;
  scanIntervalSec: number;
  refuelThreshold: number;
} {
  const all = readSettings();
  const r = all.rescue || {};
  return {
    /** Fuel % below which a bot is considered in need of rescue. */
    fuelThreshold: (r.fuelThreshold as number) || 10,
    /** Number of fuel cells to deliver per rescue. */
    rescueFuelCells: (r.rescueFuelCells as number) || 10,
    /** Credits to send per rescue (if docked at same station). */
    rescueCredits: (r.rescueCredits as number) || 500,
    /** Seconds between fleet scans. */
    scanIntervalSec: (r.scanIntervalSec as number) || 30,
    /** Keep own fuel above this %. */
    refuelThreshold: (r.refuelThreshold as number) || 60,
  };
}

// ── Helpers ──────────────────────────────────────────────────

interface RescueTarget {
  username: string;
  system: string;
  poi: string;
  fuelPct: number;
  docked: boolean;
}

/** Find bots that need fuel rescue. */
function findStrandedBots(
  fleet: BotStatus[],
  selfName: string,
  fuelThreshold: number,
): RescueTarget[] {
  const targets: RescueTarget[] = [];
  for (const bot of fleet) {
    if (bot.username === selfName) continue;
    if (bot.state !== "running" && bot.state !== "idle") continue;
    const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (fuelPct <= fuelThreshold) {
      targets.push({
        username: bot.username,
        system: bot.system,
        poi: bot.poi,
        fuelPct,
        docked: bot.docked,
      });
    }
  }
  // Sort by most critical first
  targets.sort((a, b) => a.fuelPct - b.fuelPct);
  return targets;
}

// ── FuelRescue routine ──────────────────────────────────────

/**
 * FuelRescue routine — monitors fleet and rescues stranded bots:
 *
 * 1. Scan fleet status for bots with dangerously low fuel
 * 2. Buy fuel cells at nearest station (or use existing stock)
 * 3. Navigate to stranded bot's system
 * 4. Travel to stranded bot's POI
 * 5. If same station: send_gift credits. If in space: jettison fuel cells
 * 6. Scavenge loop on the stranded bot picks up the fuel cells
 * 7. Return to idle scanning
 */
export const rescueRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const homeSystem = bot.system;

  ctx.log("system", "FuelRescue bot online — monitoring fleet for stranded ships...");

  while (bot.state === "running") {
    const settings = getRescueSettings();

    // ── Check fleet status ──
    yield "scan_fleet";
    const fleet = ctx.getFleetStatus?.() || [];
    if (fleet.length === 0) {
      ctx.log("info", "No fleet data available — waiting...");
      await sleep(settings.scanIntervalSec * 1000);
      continue;
    }

    const targets = findStrandedBots(fleet, bot.username, settings.fuelThreshold);

    if (targets.length === 0) {
      // No one needs help — scavenge where we are and idle
      yield "idle_scavenge";
      if (!bot.docked) {
        await scavengeWrecks(ctx);
      }
      await sleep(settings.scanIntervalSec * 1000);
      continue;
    }

    // ── Rescue the most critical bot ──
    const target = targets[0];
    ctx.log("rescue", `RESCUE NEEDED: ${target.username} at ${target.fuelPct}% fuel in ${target.system} (POI: ${target.poi || "unknown"})`);

    // ── Ensure we have fuel ourselves ──
    yield "self_check";
    await bot.refreshStatus();
    logStatus(ctx);

    const fueled = await ensureFueled(ctx, settings.refuelThreshold);
    if (!fueled) {
      ctx.log("error", "Cannot refuel self — waiting before retry...");
      await sleep(settings.scanIntervalSec * 1000);
      continue;
    }

    // ── Stock up on fuel cells for delivery ──
    yield "acquire_fuel";
    await ensureDocked(ctx);

    // Try buying fuel cells from market
    ctx.log("rescue", "Checking market for fuel cells...");
    const marketResp = await bot.exec("view_market");
    let hasFuelCells = false;

    if (marketResp.result && typeof marketResp.result === "object") {
      const mData = marketResp.result as Record<string, unknown>;
      const items = (
        Array.isArray(mData) ? mData :
        Array.isArray(mData.items) ? mData.items :
        Array.isArray(mData.market) ? mData.market :
        []
      ) as Array<Record<string, unknown>>;

      const fuelItem = items.find(i => {
        const id = ((i.item_id as string) || (i.id as string) || "").toLowerCase();
        return id.includes("fuel_cell") || id.includes("fuel") || id.includes("energy_cell");
      });

      if (fuelItem) {
        const fuelId = (fuelItem.item_id as string) || (fuelItem.id as string) || "";
        const price = (fuelItem.price as number) || (fuelItem.buy_price as number) || 0;
        const available = (fuelItem.quantity as number) || (fuelItem.stock as number) || 0;
        const qty = Math.min(settings.rescueFuelCells, available);

        if (qty > 0 && (price * qty) <= bot.credits) {
          ctx.log("rescue", `Buying ${qty}x fuel cells (${price}cr each)...`);
          const buyResp = await bot.exec("buy", { item_id: fuelId, quantity: qty });
          if (!buyResp.error) {
            hasFuelCells = true;
            ctx.log("rescue", `Acquired ${qty}x fuel cells`);
          } else {
            ctx.log("rescue", `Buy failed: ${buyResp.error.message}`);
          }
        }
      }
    }

    // Check if we already have fuel cells in cargo
    if (!hasFuelCells) {
      await bot.refreshCargo();
      const fuelInCargo = bot.inventory.find(i =>
        i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
      );
      if (fuelInCargo && fuelInCargo.quantity > 0) {
        hasFuelCells = true;
        ctx.log("rescue", `Already have ${fuelInCargo.quantity}x ${fuelInCargo.name} in cargo`);
      }
    }

    // If we can't get fuel cells, send credits instead (if at same station)
    const willSendCredits = !hasFuelCells && bot.credits >= settings.rescueCredits;

    if (!hasFuelCells && !willSendCredits) {
      ctx.log("error", "No fuel cells available and not enough credits to help — waiting for better situation...");
      await sleep(settings.scanIntervalSec * 1000);
      continue;
    }

    // ── Navigate to stranded bot's system ──
    yield "navigate_to_target";
    await ensureUndocked(ctx);

    if (target.system && target.system !== bot.system) {
      ctx.log("rescue", `Navigating to ${target.system}...`);
      const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
      const arrived = await navigateToSystem(ctx, target.system, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Could not reach ${target.system} — will retry next scan`);
        await sleep(settings.scanIntervalSec * 1000);
        continue;
      }
    }

    if (bot.state !== "running") break;

    // ── Travel to stranded bot's POI ──
    if (target.poi) {
      yield "travel_to_target";
      ctx.log("rescue", `Traveling to ${target.username}'s location (${target.poi})...`);
      const travelResp = await bot.exec("travel", { target_poi: target.poi });
      if (travelResp.error && !travelResp.error.message.includes("already")) {
        ctx.log("error", `Travel failed: ${travelResp.error.message}`);
        // Try docking at station to send gift instead
      }
      bot.poi = target.poi;
    }

    // ── Deliver fuel ──
    yield "deliver_fuel";

    if (target.docked) {
      // Target is docked — dock at same station and send gift
      ctx.log("rescue", `${target.username} is docked — docking to send gift...`);
      const dockResp = await bot.exec("dock");
      if (!dockResp.error || dockResp.error.message.includes("already")) {
        bot.docked = true;
        await collectFromStorage(ctx);

        if (hasFuelCells) {
          // Send fuel cells
          await bot.refreshCargo();
          const fuelItem = bot.inventory.find(i =>
            i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
          );
          if (fuelItem) {
            ctx.log("rescue", `Sending ${fuelItem.quantity}x ${fuelItem.name} to ${target.username}...`);
            await bot.exec("send_gift", {
              recipient: target.username,
              item_id: fuelItem.itemId,
              quantity: fuelItem.quantity,
              message: "Emergency fuel delivery from FuelRescue bot!",
            });
          }
        }

        if (willSendCredits || bot.credits >= settings.rescueCredits) {
          ctx.log("rescue", `Sending ${settings.rescueCredits} credits to ${target.username}...`);
          await bot.exec("send_gift", {
            recipient: target.username,
            credits: settings.rescueCredits,
            message: "Emergency credits from FuelRescue bot — refuel ASAP!",
          });
        }

        ctx.log("rescue", `Delivery complete for ${target.username}!`);
      }
    } else {
      // Target is in space — jettison fuel cells for them to scavenge
      if (hasFuelCells) {
        await bot.refreshCargo();
        const fuelItem = bot.inventory.find(i =>
          i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
        );
        if (fuelItem) {
          ctx.log("rescue", `Jettisoning ${fuelItem.quantity}x ${fuelItem.name} for ${target.username} to collect...`);
          const jetResp = await bot.exec("jettison", {
            item_id: fuelItem.itemId,
            quantity: fuelItem.quantity,
          });
          if (jetResp.error) {
            ctx.log("error", `Jettison failed: ${jetResp.error.message}`);
          } else {
            ctx.log("rescue", `Fuel cells jettisoned at ${target.poi || bot.poi} — ${target.username} should scavenge them`);
          }
        }
      } else {
        // Can't help in space without fuel cells — dock at nearest station and send credits
        ctx.log("rescue", "No fuel cells to jettison — looking for station to send credits...");
        const { pois } = await getSystemInfo(ctx);
        const station = findStation(pois);
        if (station) {
          ctx.log("rescue", `Docking at ${station.name} to send credits...`);
          await bot.exec("travel", { target_poi: station.id });
          await bot.exec("dock");
          bot.docked = true;
          await collectFromStorage(ctx);
          if (bot.credits >= settings.rescueCredits) {
            await bot.exec("send_gift", {
              recipient: target.username,
              credits: settings.rescueCredits,
              message: "Emergency credits — dock here to collect and refuel!",
            });
            ctx.log("rescue", `Sent ${settings.rescueCredits} credits to ${target.username}'s storage at ${station.name}`);
          }
        }
      }
    }

    // ── Return to home system ──
    if (homeSystem && bot.system !== homeSystem) {
      yield "return_home";
      ctx.log("rescue", `Returning to home system ${homeSystem}...`);
      await ensureUndocked(ctx);
      const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
      await navigateToSystem(ctx, homeSystem, safetyOpts);
    }

    // ── Refuel self ──
    yield "self_refuel";
    await ensureFueled(ctx, settings.refuelThreshold);
    await bot.refreshStatus();
    logStatus(ctx);

    ctx.log("rescue", `=== Rescue mission for ${target.username} complete ===`);

    // Short cooldown before next scan
    await sleep(10000);
  }
};
