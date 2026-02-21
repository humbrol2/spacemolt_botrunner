import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { BotStatus } from "../bot.js";
import { mapStore } from "../mapstore.js";
import type { ServerWebSocket } from "bun";

// ── Types ──────────────────────────────────────────────────

export interface WebAction {
  type: "start" | "stop" | "add" | "register" | "chat" | "saveSettings" | "exec";
  bot?: string;
  routine?: string;
  username?: string;
  password?: string;
  empire?: string;
  message?: string;
  channel?: string;
  registration_code?: string;
  settings?: Record<string, unknown>;
  command?: string;
  params?: Record<string, unknown>;
}

export interface WebActionResult {
  ok: boolean;
  message?: string;
  error?: string;
  password?: string;
  settings?: Record<string, Record<string, unknown>>;
  data?: unknown;
}

export interface RoutineSettings {
  [routine: string]: Record<string, unknown>;
}

type WSData = { id: number };

// ── Settings persistence ───────────────────────────────────

const DATA_DIR = join(process.cwd(), "data");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

function loadSettings(): RoutineSettings {
  if (existsSync(SETTINGS_FILE)) {
    try {
      return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as RoutineSettings;
    } catch { /* corrupt — start fresh */ }
  }
  return {};
}

function saveSettings(s: RoutineSettings): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2) + "\n", "utf-8");
}

// ── WebServer ──────────────────────────────────────────────

const MAX_LOG_BUFFER = 200;

export class WebServer {
  private port: number;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private clients = new Set<ServerWebSocket<WSData>>();
  private nextClientId = 1;

  // Log buffers for scrollback on reconnect
  private activityLog: string[] = [];
  private broadcastLog: string[] = [];
  private systemLog: string[] = [];

  // Per-bot activity log buffers (username -> lines)
  private botLogs = new Map<string, string[]>();

  // Latest bot statuses for initial page load
  private latestStatuses: BotStatus[] = [];

  // Persisted routine settings
  settings: RoutineSettings;

  // Action callback — set by botmanager
  onAction: ((action: WebAction) => Promise<WebActionResult>) | null = null;

  // Available routines — set by botmanager
  routines: string[] = [];

  constructor(port: number = 3000) {
    this.port = port;
    this.settings = loadSettings();
  }

  getSettings(routine: string): Record<string, unknown> {
    return this.settings[routine] || {};
  }

  saveRoutineSettings(routine: string, s: Record<string, unknown>): void {
    this.settings[routine] = s;
    saveSettings(this.settings);
  }

  start(): void {
    const indexPath = join(import.meta.dir, "index.html");

    this.server = Bun.serve<WSData>({
      port: this.port,
      fetch: async (req, server) => {
        const url = new URL(req.url);

        // WebSocket upgrade
        if (url.pathname === "/ws") {
          const id = this.nextClientId++;
          const ok = server.upgrade(req, { data: { id } });
          if (ok) return undefined as unknown as Response;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        // REST API
        if (url.pathname === "/api/bots") {
          return Response.json(this.latestStatuses);
        }
        if (url.pathname === "/api/map") {
          return Response.json({ systems: mapStore.getAllSystems() });
        }
        if (url.pathname === "/api/routines") {
          return Response.json(this.routines);
        }
        if (url.pathname === "/api/settings") {
          return Response.json(this.settings);
        }

        // POST actions (fallback for non-WS clients)
        if (url.pathname === "/api/action" && req.method === "POST") {
          const action = (await req.json()) as WebAction;
          if (this.onAction) {
            const result = await this.onAction(action);
            return Response.json(result);
          }
          return Response.json({ ok: false, error: "No action handler" });
        }

        // Serve index.html for all other routes (read fresh for dev, no cache)
        return new Response(readFileSync(indexPath, "utf-8"), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      },

      websocket: {
        open: (ws: ServerWebSocket<WSData>) => {
          this.clients.add(ws);

          // Build known systems list for settings dropdowns
          const knownSystems = this.getKnownSystemsList();
          const knownOres = mapStore.getAllKnownOres();

          // Send scrollback and current state
          // Serialize per-bot logs as { username: lines[] }
          const botLogsObj: Record<string, string[]> = {};
          for (const [name, lines] of this.botLogs) {
            botLogsObj[name] = lines;
          }

          ws.send(JSON.stringify({
            type: "init",
            bots: this.latestStatuses,
            routines: this.routines,
            settings: this.settings,
            knownSystems,
            knownOres,
            mapData: mapStore.getAllSystems(),
            logs: {
              activity: this.activityLog,
              broadcast: this.broadcastLog,
              system: this.systemLog,
            },
            botLogs: botLogsObj,
          }));
        },

        message: async (ws: ServerWebSocket<WSData>, msg: string | Buffer) => {
          let seq: unknown;
          let isExec = false;
          try {
            const raw = JSON.parse(typeof msg === "string" ? msg : msg.toString());
            seq = raw._seq;
            isExec = raw.type === "exec";
            const data = raw as WebAction;
            if (this.onAction) {
              const result = await this.onAction(data);
              const resType = isExec ? "execResult" : "actionResult";
              ws.send(JSON.stringify({ type: resType, _seq: seq, ...result }));
            }
          } catch (err) {
            ws.send(JSON.stringify({
              type: isExec ? "execResult" : "actionResult",
              _seq: seq,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }));
          }
        },

        close: (ws: ServerWebSocket<WSData>) => {
          this.clients.delete(ws);
        },
      },
    });

    console.log(`Dashboard: http://localhost:${this.port}`);
  }

  stop(): void {
    this.server?.stop();
  }

  // ── Interface matching TUI ─────────────────────────────────

  updateBotStatus(bots: BotStatus[]): void {
    this.latestStatuses = bots;
    this.broadcast({ type: "status", bots });
  }

  logActivity(line: string): void {
    this.pushLog(this.activityLog, line);
    this.broadcast({ type: "log", panel: "activity", line });
  }

  logBroadcast(line: string): void {
    this.pushLog(this.broadcastLog, line);
    this.broadcast({ type: "log", panel: "broadcast", line });
  }

  logSystem(line: string): void {
    this.pushLog(this.systemLog, line);
    this.broadcast({ type: "log", panel: "system", line });
  }

  logBot(username: string, line: string): void {
    if (!this.botLogs.has(username)) {
      this.botLogs.set(username, []);
    }
    const buf = this.botLogs.get(username)!;
    this.pushLog(buf, line);
    this.broadcast({ type: "botLog", username, line });
  }

  updateMapData(): void {
    this.broadcast({
      type: "mapUpdate",
      mapData: mapStore.getAllSystems(),
      knownOres: mapStore.getAllKnownOres(),
    });
  }

  // ── Internal helpers ───────────────────────────────────────

  private getKnownSystemsList(): Array<{ id: string; name: string }> {
    const ids = mapStore.getKnownSystems();
    return ids.map(id => {
      const sys = mapStore.getSystem(id);
      return { id, name: sys?.name || id };
    });
  }

  private pushLog(buffer: string[], line: string): void {
    buffer.push(line);
    if (buffer.length > MAX_LOG_BUFFER) {
      buffer.shift();
    }
  }

  private broadcast(data: unknown): void {
    const msg = JSON.stringify(data);
    for (const ws of this.clients) {
      try {
        ws.send(msg);
      } catch {
        this.clients.delete(ws);
      }
    }
  }
}
