import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { Bot, type Routine } from "./bot.js";
import { SessionManager } from "./session.js";
import { minerRoutine } from "./routines/miner.js";
import { explorerRoutine } from "./routines/explorer.js";
import { crafterRoutine } from "./routines/crafter.js";
import { rescueRoutine } from "./routines/rescue.js";
import { mapStore } from "./mapstore.js";
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

function setupBotLogging(bot: Bot): void {
  bot.onLog = (username, category, message) => {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    const line = `${timestamp} [${username}] [${category}] ${message}`;
    debugLog("bot:onLog", `${username} cat=${category}`, message);
    if (category === "system" || category === "error") {
      server.logSystem(line);
    }
    server.logActivity(line);
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

  const startOpts = routineKey === "rescue"
    ? { getFleetStatus: () => [...bots.values()].map(b => b.status()) }
    : undefined;

  bot.start(routineKey, routine.fn, startOpts).catch((err) => {
    server.logSystem(`Bot ${bot.username} crashed: ${err}`);
  });

  return { ok: true, message: `Started ${botName} with ${routine.name}` };
}

async function handleStop(action: WebAction): Promise<WebActionResult> {
  const botName = action.bot;
  if (!botName) return { ok: false, error: "No bot specified" };

  const bot = bots.get(botName);
  if (!bot) return { ok: false, error: `Bot not found: ${botName}` };
  if (bot.state !== "running") return { ok: false, error: `${botName} is not running` };

  bot.stop();
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
  const resp = await bot.exec(command, params);

  // Refresh cached state after mutating commands
  const refreshCommands = new Set([
    "mine", "sell", "buy", "dock", "undock", "travel", "jump",
    "refuel", "repair", "deposit_items", "withdraw_items", "jettison",
    "attack", "loot_wreck", "salvage_wreck", "send_gift", "craft",
    "accept_mission", "complete_mission", "abandon_mission",
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

  if (resp.error) {
    return { ok: false, error: resp.error.message, data: resp.result };
  }

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
  if (bots.size > 0) {
    server.logSystem(`Found ${bots.size} saved bot(s): ${[...bots.keys()].join(", ")}`);
    for (const [, bot] of bots) {
      bot.login().then(() => refreshStatusTable()).catch(() => {});
    }
  }

  refreshStatusTable();

  // Periodic UI push (cached data → websocket clients)
  setInterval(() => {
    refreshStatusTable();
  }, 2000);

  // Periodic live refresh (hit API for all logged-in bots)
  setInterval(async () => {
    for (const [, bot] of bots) {
      if (bot.api.getSession()) {
        await bot.refreshStatus().catch(() => {});
      }
    }
    refreshStatusTable();
  }, 30000);

  // Periodic map data push (every 15s so dashboard stays current)
  setInterval(() => {
    server.updateMapData();
  }, 15000);

  // Start HTTP + WebSocket server
  server.start();

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    for (const [, bot] of bots) {
      if (bot.state === "running") bot.stop();
    }
    mapStore.flush();
    server.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
