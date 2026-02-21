import { existsSync, readdirSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { Bot, type Routine } from "./bot.js";
import { SessionManager } from "./session.js";
import { minerRoutine } from "./routines/miner.js";
import { explorerRoutine } from "./routines/explorer.js";
import { crafterRoutine } from "./routines/crafter.js";
import { rescueRoutine } from "./routines/rescue.js";
import { coordinatorRoutine } from "./routines/coordinator.js";
import { traderRoutine } from "./routines/trader.js";
import { gasHarvesterRoutine } from "./routines/gas_harvester.js";
import { iceHarvesterRoutine } from "./routines/ice_harvester.js";
import { salvagerRoutine } from "./routines/salvager.js";
import { hunterRoutine } from "./routines/hunter.js";
import { mapStore } from "./mapstore.js";
import { catalogStore } from "./catalogstore.js";
import { WebServer, type WebAction, type WebActionResult } from "./web/server.js";
import { setLogSink } from "./ui.js";
import { debugLog } from "./debug.js";

const BASE_DIR = process.cwd();
const SESSIONS_DIR = join(BASE_DIR, "sessions");

const bots: Map<string, Bot> = new Map();
let server: WebServer;

const ROUTINES: Record<string, { name: string; fn: Routine }> = {
  miner: { name: "Miner", fn: minerRoutine },
  explorer: { name: "Explorer", fn: explorerRoutine },
  crafter: { name: "Crafter", fn: crafterRoutine },
  rescue: { name: "FuelRescue", fn: rescueRoutine },
  coordinator: { name: "Coordinator", fn: coordinatorRoutine },
  trader: { name: "Trader", fn: traderRoutine },
  gas_harvester: { name: "GasHarvester", fn: gasHarvesterRoutine },
  ice_harvester: { name: "IceHarvester", fn: iceHarvesterRoutine },
  salvager: { name: "Salvager", fn: salvagerRoutine },
  hunter: { name: "Hunter", fn: hunterRoutine },
};

// ── Auto-discover existing sessions ─────────────────────────

function discoverBots(): void {
  if (!existsSync(SESSIONS_DIR)) return;
  const dirs = readdirSync(SESSIONS_DIR, { withFileTypes: true });
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const name = d.name;
    if (bots.has(name)) continue;
    const credPath = join(SESSIONS_DIR, name, "credentials.json");
    if (existsSync(credPath)) {
      const bot = new Bot(name, BASE_DIR);
      setupBotLogging(bot);
      bots.set(name, bot);
    }
  }
}

/** Categories that go to the broadcast panel instead of bot log. */
const BROADCAST_CATEGORIES = new Set(["broadcast", "chat", "dm"]);

const LOGS_DIR = join(BASE_DIR, "data", "logs");

/** Append a line to a bot's persistent log file (data/logs/{username}.log). */
function appendBotLog(username: string, line: string): void {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(join(LOGS_DIR, `${username}.log`), line + "\n");
  } catch { /* ignore write errors */ }
}

function setupBotLogging(bot: Bot): void {
  bot.onLog = (username, category, message) => {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    const datestamp = new Date().toISOString().slice(0, 10);
    const line = `${timestamp} [${username}] [${category}] ${message}`;
    debugLog("bot:onLog", `${username} cat=${category}`, message);
    if (category === "system" || category === "error") {
      server.logSystem(line);
    }
    server.logActivity(line);
    // Per-bot log for profile page activity log
    const botLine = `${timestamp} [${category}] ${message}`;
    server.logBot(username, botLine);
    // Persistent per-bot log file
    appendBotLog(username, `${datestamp} ${botLine}`);
  };
  bot.onFactionLog = (_username, line) => {
    server.logFaction(line);
  };
}

function refreshStatusTable(): void {
  const statuses = [...bots.values()].map((b) => b.status());
  server.updateBotStatus(statuses);
}

// ── Action handlers ─────────────────────────────────────────

async function handleAction(action: WebAction): Promise<WebActionResult> {
  switch (action.type) {
    case "start":
      return handleStart(action);
    case "stop":
      return handleStop(action);
    case "add":
      return handleAdd(action);
    case "register":
      return handleRegister(action);
    case "chat":
      return handleChat(action);
    case "saveSettings":
      return handleSaveSettings(action);
    case "exec":
      return handleExec(action);
    default:
      return { ok: false, error: `Unknown action: ${(action as any).type}` };
  }
}

async function handleSaveSettings(action: WebAction): Promise<WebActionResult> {
  const routine = (action as any).routine as string;
  const s = action.settings;
  if (!routine || !s) return { ok: false, error: "Routine and settings required" };

  server.saveRoutineSettings(routine, s);
  server.logSystem(`Settings saved for ${routine}`);
  return { ok: true, message: `${routine} settings saved`, settings: server.settings };
}

async function handleStart(action: WebAction): Promise<WebActionResult> {
  const botName = action.bot;
  if (!botName) return { ok: false, error: "No bot specified" };

  const bot = bots.get(botName);
  if (!bot) return { ok: false, error: `Bot not found: ${botName}` };
  if (bot.state === "running") return { ok: false, error: `${botName} is already running` };

  const routineKey = action.routine || "miner";
  const routine = ROUTINES[routineKey];
  if (!routine) return { ok: false, error: `Unknown routine: ${routineKey}` };

  server.logSystem(`Starting ${bot.username} with ${routine.name} routine...`);

  const startOpts = (routineKey === "rescue" || routineKey === "coordinator")
    ? { getFleetStatus: () => [...bots.values()].map(b => b.status()) }
    : undefined;

  bot.start(routineKey, routine.fn, startOpts).then(() => {
    server.logSystem(`Bot ${bot.username} routine finished.`);
    server.clearBotAssignment(botName);
  }).catch((err) => {
    server.logSystem(`Bot ${bot.username} crashed: ${err}`);
    server.clearBotAssignment(botName);
  });

  server.saveBotAssignment(botName, routineKey);

  return { ok: true, message: `Started ${botName} with ${routine.name}` };
}

async function handleStop(action: WebAction): Promise<WebActionResult> {
  const botName = action.bot;
  if (!botName) return { ok: false, error: "No bot specified" };

  const bot = bots.get(botName);
  if (!bot) return { ok: false, error: `Bot not found: ${botName}` };
  if (bot.state !== "running") return { ok: false, error: `${botName} is not running` };

  bot.stop();
  server.clearBotAssignment(botName);
  server.logSystem(`Stop signal sent to ${bot.username}`);
  return { ok: true, message: `Stop signal sent to ${botName}` };
}

async function handleAdd(action: WebAction): Promise<WebActionResult> {
  const { username, password } = action;
  if (!username || !password) return { ok: false, error: "Username and password required" };

  if (bots.has(username)) return { ok: false, error: `Bot already exists: ${username}` };

  const session = new SessionManager(username, BASE_DIR);
  session.saveCredentials({ username, password, empire: "", playerId: "" });

  const bot = new Bot(username, BASE_DIR);
  setupBotLogging(bot);
  bots.set(username, bot);

  server.logSystem(`Verifying credentials for ${username}...`);
  const ok = await bot.login();
  if (ok) {
    const s = bot.status();
    server.logSystem(`Added ${username}! Location: ${s.location}, Credits: ${s.credits}`);
  } else {
    server.logSystem(`Login failed for ${username} -- credentials saved, retry later.`);
  }
  refreshStatusTable();
  return { ok: true, message: `Bot added: ${username}` };
}

async function handleRegister(action: WebAction): Promise<WebActionResult> {
  const { username, empire, registration_code } = action;
  if (!username) return { ok: false, error: "Username required" };
  if (!registration_code) return { ok: false, error: "Registration code required (get one from spacemolt.com/dashboard)" };

  const selectedEmpire = empire || "solarian";
  server.logSystem(`Registering ${username} in ${selectedEmpire}...`);

  const tempBot = new Bot(username, BASE_DIR);
  const resp = await tempBot.exec("register", { username, empire: selectedEmpire, registration_code });

  if (resp.error) {
    server.logSystem(`Registration failed: ${resp.error.message}`);
    return { ok: false, error: `Registration failed: ${resp.error.message}` };
  }

  const result = resp.result as Record<string, unknown> | undefined;
  const password = (result?.password as string) || "";
  const playerId = (result?.player_id as string) || "";

  if (!password) {
    server.logSystem("Registration succeeded but no password returned.");
    return { ok: false, error: "No password returned" };
  }

  server.logSystem(`Registration successful! PASSWORD: ${password}`);
  server.logSystem("SAVE THIS PASSWORD! It cannot be recovered.");

  const session = new SessionManager(username, BASE_DIR);
  session.saveCredentials({ username, password, empire: selectedEmpire, playerId });

  const bot = new Bot(username, BASE_DIR);
  setupBotLogging(bot);
  bots.set(username, bot);
  server.logSystem(`Bot added: ${username}`);
  refreshStatusTable();

  return { ok: true, message: `Registered ${username}`, password };
}

async function handleChat(action: WebAction): Promise<WebActionResult> {
  const { bot: botName, message, channel } = action;
  if (!botName || !message) return { ok: false, error: "Bot and message required" };

  const bot = bots.get(botName);
  if (!bot) return { ok: false, error: `Bot not found: ${botName}` };

  if (!bot.api.getSession()) {
    await bot.login();
  }

  const resp = await bot.exec("chat", { content: message, channel: channel || "system" });
  if (resp.error) {
    return { ok: false, error: `Chat failed: ${resp.error.message}` };
  }

  server.logSystem(`[${channel || "system"}] ${bot.username}: ${message}`);
  return { ok: true, message: `Message sent as ${bot.username}` };
}

async function handleExec(action: WebAction): Promise<WebActionResult> {
  const { bot: botName, command, params } = action;
  if (!botName || !command) return { ok: false, error: "Bot and command required" };

  const bot = bots.get(botName);
  if (!bot) return { ok: false, error: `Bot not found: ${botName}` };

  if (!bot.api.getSession()) {
    await bot.login();
  }

  debugLog("exec:handler", `${botName} > ${command}`, params);
  let resp = await bot.exec(command, params);

  // If still getting auth errors after API's internal recovery, do a full re-login and retry once
  if (resp.error) {
    const code = resp.error.code;
    if (code === "session_invalid" || code === "session_expired" || code === "not_authenticated") {
      server.logSystem(`Session lost for ${botName}, re-logging in...`);
      const ok = await bot.login();
      if (ok) {
        resp = await bot.exec(command, params);
      }
    }
  }

  // Refresh cached state after mutating commands
  const refreshCommands = new Set([
    "mine", "sell", "buy", "dock", "undock", "travel", "jump",
    "refuel", "repair", "deposit_items", "withdraw_items", "jettison",
    "attack", "loot_wreck", "salvage_wreck", "send_gift", "craft",
    "accept_mission", "complete_mission", "abandon_mission",
    "buy_ship", "sell_ship", "switch_ship", "install_mod", "uninstall_mod", "set_colors",
  ]);
  if (refreshCommands.has(command)) {
    await bot.refreshStatus();

    // Also refresh the recipient bot after gift/trade
    if (command === "send_gift" || command === "trade_offer") {
      const recipient = (params as Record<string, unknown> | undefined)?.recipient as string | undefined;
      const recipientBot = recipient ? bots.get(recipient) : undefined;
      if (recipientBot) {
        // Credits go to recipient's storage locker — auto-withdraw if docked
        if (recipientBot.docked && recipientBot.api.getSession()) {
          const giftCredits = (params as Record<string, unknown> | undefined)?.credits as number | undefined;
          if (giftCredits && giftCredits > 0) {
            server.logSystem(`Auto-withdrawing ${giftCredits} credits from storage for ${recipient}...`);
            await recipientBot.exec("withdraw_credits", { amount: giftCredits });
          }
        }
        await recipientBot.refreshStatus();
      }
    }

    refreshStatusTable();
  }

  // Log manual faction operations to faction activity log
  if (!resp.error) {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    const p = params as Record<string, unknown> | undefined;
    switch (command) {
      case "faction_deposit_credits": {
        const amt = p?.amount as number | undefined;
        if (amt) server.logFaction(`${timestamp} [deposit] ${botName}: Deposited ${amt}cr to faction treasury`);
        break;
      }
      case "faction_withdraw_credits": {
        const amt = p?.amount as number | undefined;
        if (amt) server.logFaction(`${timestamp} [withdraw] ${botName}: Withdrew ${amt}cr from faction treasury`);
        break;
      }
      case "faction_deposit_items": {
        const itemId = p?.item_id as string | undefined;
        const qty = p?.quantity as number | undefined;
        if (itemId) server.logFaction(`${timestamp} [deposit] ${botName}: Deposited ${qty || 1}x ${itemId} to faction storage`);
        break;
      }
      case "faction_withdraw_items": {
        const itemId = p?.item_id as string | undefined;
        const qty = p?.quantity as number | undefined;
        if (itemId) server.logFaction(`${timestamp} [withdraw] ${botName}: Withdrew ${qty || 1}x ${itemId} from faction storage`);
        break;
      }
    }
  }

  if (resp.error) {
    debugLog("exec:result", `${botName} > ${command} ERROR`, { error: resp.error.message, hasResult: resp.result !== undefined });
    return { ok: false, error: resp.error.message, data: resp.result };
  }

  debugLog("exec:result", `${botName} > ${command} OK`, { hasResult: resp.result !== undefined, resultType: typeof resp.result });
  return { ok: true, message: `${command} executed`, data: resp.result };
}

// ── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const port = parseInt(process.env.PORT || "3000", 10);
  server = new WebServer(port);
  server.routines = Object.keys(ROUTINES);
  server.onAction = handleAction;

  // Route global ui.log() calls through the web server
  setLogSink((category, message) => {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    debugLog("sink:route", `category=${category}`, message);
    if (BROADCAST_CATEGORIES.has(category)) {
      const tagMatch = message.match(/^\[([^\]]+)\]\s*(.*)/s);
      if (tagMatch) {
        const [, tag, content] = tagMatch;
        debugLog("sink:broadcast", `tag=${tag}`, content);
        server.logBroadcast(`${tag} ${timestamp}`);
        server.logBroadcast(content);
        server.logBroadcast("");
      } else {
        server.logBroadcast(`${timestamp} ${message}`);
      }
      return;
    }
    const line = `${timestamp} [${category}] ${message}`;
    if (category === "error") {
      debugLog("sink:system", "error routed to system panel", line);
      server.logSystem(line);
    }
    debugLog("sink:activity", "routed to bot log", line);
    server.logActivity(line);
  });

  server.logSystem("SpaceMolt Bot Manager v0.2");
  server.logSystem("Loading saved sessions...");

  discoverBots();

  // Seed galaxy map from public API so pathfinding works from first run
  server.logSystem("Seeding galaxy map from /api/map...");
  mapStore.seedFromMapAPI().then(({ seeded, known, failed }) => {
    if (failed) {
      server.logSystem("Galaxy map seed failed — will rely on exploration data");
    } else {
      server.logSystem(`Galaxy map seeded: ${seeded} new system(s), ${known} already known`);
    }
  }).catch(() => {
    server.logSystem("Galaxy map seed failed — will rely on exploration data");
  });

  if (bots.size > 0) {
    const assignments = server.getBotAssignments();
    server.logSystem(`Found ${bots.size} saved bot(s): ${[...bots.keys()].join(", ")}`);

    // Stagger logins to avoid spamming the API
    const LOGIN_DELAY_MS = 5000;
    let loginIndex = 0;
    for (const [name, bot] of bots) {
      const delay = loginIndex * LOGIN_DELAY_MS;
      loginIndex++;
      setTimeout(() => {
        bot.login().then(async (ok) => {
          refreshStatusTable();
          if (!ok) return;
          // Fetch catalog data if stale (first logged-in bot triggers it)
          if (catalogStore.isStale()) {
            try {
              await catalogStore.fetchAll(bot.api);
              server.logSystem(`Catalog fetched (${catalogStore.getSummary()})`);
            } catch (err) {
              server.logSystem(`Catalog fetch failed: ${err}`);
            }
          }
          const routineKey = assignments[name];
          if (!routineKey || !ROUTINES[routineKey]) return;
          server.logSystem(`Auto-resuming ${name} with ${ROUTINES[routineKey].name}...`);
          await handleStart({ type: "start", bot: name, routine: routineKey });
        }).catch((err) => {
          server.logSystem(`Login failed for ${name}: ${err}`);
        });
      }, delay);
    }
  }

  refreshStatusTable();

  // Load catalog data (fetch if stale, using first available bot session)
  if (!catalogStore.isStale()) {
    server.logSystem(`Catalog loaded from cache (${catalogStore.getSummary()})`);
  } else {
    server.logSystem("Catalog data is stale, will fetch after first bot login...");
  }

  // Periodic timers (store IDs for cleanup)
  const intervals: ReturnType<typeof setInterval>[] = [];

  // Periodic UI push (cached data → websocket clients)
  intervals.push(setInterval(() => {
    refreshStatusTable();
  }, 2000));

  // Periodic live refresh (hit API for all logged-in bots)
  intervals.push(setInterval(async () => {
    for (const [, bot] of bots) {
      if (bot.api.getSession()) {
        await bot.refreshStatus().catch(() => {});
      }
    }
    refreshStatusTable();
  }, 30000));

  // Periodic map data push (every 15s so dashboard stays current)
  intervals.push(setInterval(() => {
    server.updateMapData();
  }, 15000));

  // Periodic stats flush (every 60s)
  intervals.push(setInterval(() => {
    const statuses = [...bots.values()].map(b => b.status());
    server.flushBotStats(statuses);
  }, 60000));

  // Daily catalog refresh (24h)
  intervals.push(setInterval(async () => {
    if (!catalogStore.isStale()) return;
    // Find first bot with an active session
    for (const [, bot] of bots) {
      if (bot.api.getSession()) {
        try {
          await catalogStore.fetchAll(bot.api);
          server.logSystem(`Catalog refreshed (${catalogStore.getSummary()})`);
        } catch (err) {
          server.logSystem(`Catalog refresh failed: ${err}`);
        }
        break;
      }
    }
  }, 24 * 60 * 60 * 1000));

  // Start HTTP + WebSocket server
  server.start();

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    // Clear intervals
    for (const id of intervals) clearInterval(id);
    // Flush stats before stopping bots
    const statuses = [...bots.values()].map(b => b.status());
    server.flushBotStats(statuses);
    for (const [, bot] of bots) {
      if (bot.state === "running") bot.stop();
    }
    mapStore.flush();
    catalogStore.flush();
    server.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
