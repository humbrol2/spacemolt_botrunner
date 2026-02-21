import { SpaceMoltAPI, type ApiResponse } from "./api.js";
import { SessionManager, type Credentials } from "./session.js";
import { log, logError, logNotifications } from "./ui.js";
import { debugLog } from "./debug.js";
import { mapStore } from "./mapstore.js";

export type BotState = "idle" | "running" | "stopping" | "error";

export interface CargoItem {
  itemId: string;
  name: string;
  quantity: number;
}

export interface BotStatus {
  username: string;
  state: BotState;
  routine: string | null;
  credits: number;
  fuel: number;
  maxFuel: number;
  cargo: number;
  cargoMax: number;
  location: string;
  system: string;
  poi: string;
  docked: boolean;
  lastAction: string;
  error: string | null;
  shipName: string;
  hull: number;
  maxHull: number;
  shield: number;
  maxShield: number;
  ammo: number;
  inventory: CargoItem[];
  storage: CargoItem[];
}

export interface RoutineContext {
  api: SpaceMoltAPI;
  bot: Bot;
  log: (category: string, message: string) => void;
  /** Optional: get status of all bots in the fleet (used by rescue routine). */
  getFleetStatus?: () => BotStatus[];
}

/** A routine is an async generator that yields state names as it progresses. */
export type Routine = (ctx: RoutineContext) => AsyncGenerator<string, void, void>;

const BOT_COLORS = [
  "\x1b[96m", // bright cyan
  "\x1b[93m", // bright yellow
  "\x1b[92m", // bright green
  "\x1b[95m", // bright magenta
  "\x1b[94m", // bright blue
  "\x1b[91m", // bright red
];
const RESET = "\x1b[0m";

let colorIndex = 0;

export class Bot {
  readonly username: string;
  readonly api: SpaceMoltAPI;
  readonly session: SessionManager;
  private color: string;
  private _state: BotState = "idle";
  private _routine: string | null = null;
  private _lastAction = "";
  private _error: string | null = null;
  private _abortController: AbortController | null = null;

  // Cached game state from last get_status
  credits = 0;
  fuel = 0;
  maxFuel = 0;
  cargo = 0;
  cargoMax = 0;
  location = "unknown";
  system = "unknown";
  poi = "";
  docked = false;
  shipName = "";
  hull = 0;
  maxHull = 0;
  shield = 0;
  maxShield = 0;
  ammo = 0;

  /** Cached inventory items from last get_cargo. */
  inventory: CargoItem[] = [];

  /** Cached station storage items from last view_storage. */
  storage: CargoItem[] = [];

  // Action log (last N entries)
  readonly actionLog: string[] = [];
  private maxLogEntries = 200;

  /** Optional callback for routing log output (e.g. to TUI). */
  onLog?: (username: string, category: string, message: string) => void;

  /** Cached skill levels for detecting level-ups. */
  private skillLevels: Map<string, number> = new Map();

  constructor(username: string, baseDir: string) {
    this.username = username;
    this.api = new SpaceMoltAPI();
    this.session = new SessionManager(username, baseDir);
    this.color = BOT_COLORS[colorIndex % BOT_COLORS.length];
    colorIndex++;
  }

  get state(): BotState {
    return this._state;
  }

  get routineName(): string | null {
    return this._routine;
  }

  log(category: string, message: string): void {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    const line = `${timestamp} [${category}] ${message}`;
    this.actionLog.push(line);
    if (this.actionLog.length > this.maxLogEntries) {
      this.actionLog.shift();
    }
    if (this.onLog) {
      this.onLog(this.username, category, message);
    } else {
      console.log(
        `\x1b[2m${timestamp}${RESET} ${this.color}[${this.username}]${RESET} ` +
          `${getCategoryColor(category)}[${category}]${RESET} ${message}`
      );
    }
  }

  /** Execute an API command, log the result, handle notifications. */
  async exec(command: string, payload?: Record<string, unknown>): Promise<ApiResponse> {
    this._lastAction = command;
    debugLog("bot:exec", `${this.username} > ${command}`, payload);
    const resp = await this.api.execute(command, payload);

    if (resp.notifications && Array.isArray(resp.notifications) && resp.notifications.length > 0) {
      logNotifications(resp.notifications);

      // Parse pirate attack notifications — log to activity log and record sighting.
      // This fires for ALL routines so every bot surfaces pirate encounters.
      for (const notif of resp.notifications) {
        if (typeof notif !== "object" || !notif) continue;
        const n = notif as Record<string, unknown>;
        if (!n.pirate_id && !n.pirate_name) continue;

        const pirateName = (n.pirate_name as string) || "Unknown Pirate";
        const pirateId = (n.pirate_id as string) || "";
        const tier = (n.pirate_tier as string) || "";
        const damage = (n.damage as number) ?? 0;
        const hull = (n.your_hull as number);
        const maxHull = (n.your_max_hull as number);

        this.log("combat", `⚔ Under attack from ${pirateName}${tier ? ` (${tier})` : ""}! Took ${damage} damage. Hull: ${hull}/${maxHull}`);

        if (this.system) {
          mapStore.recordPirate(this.system, { player_id: pirateId || undefined, name: pirateName });
        }
      }
    }

    if (resp.error) {
      this.log("error", `${command}: ${resp.error.message}`);
    }

    return resp;
  }

  /** Login using stored credentials. Returns true on success. */
  async login(): Promise<boolean> {
    const creds = this.session.loadCredentials();
    if (!creds) {
      this._error = "No credentials found";
      this._state = "error";
      return false;
    }

    this.api.setCredentials(creds.username, creds.password);
    this.log("system", `Logging in as ${creds.username}...`);
    const resp = await this.exec("login", {
      username: creds.username,
      password: creds.password,
    });

    if (resp.error) {
      this._error = `Login failed: ${resp.error.message}`;
      this._state = "error";
      return false;
    }

    this.log("system", "Login successful");
    await this.refreshStatus();
    return true;
  }

  /** Fetch current game state and cache it. */
  async refreshStatus(): Promise<ApiResponse> {
    const resp = await this.exec("get_status");
    debugLog("bot:refreshStatus", `${this.username} get_status response`, resp.result);
    if (resp.result && typeof resp.result === "object") {
      const r = resp.result as Record<string, unknown>;
      debugLog("bot:refreshStatus", `${this.username} top-level keys`, Object.keys(r));

      // Player data may be nested under r.player or flat at top level
      const player = r.player as Record<string, unknown> | undefined;
      const p = player || r;

      this.credits = (p.credits as number) ?? this.credits;
      debugLog("bot:credits", `${this.username} credits=${this.credits} raw=${p.credits}`);
      this.system = (p.current_system as string) ?? this.system;
      this.poi = (p.current_poi as string) ?? (p.poi_id as string) ?? this.poi;
      this.docked = p.docked_at_base != null
        ? !!(p.docked_at_base)
        : (p.docked as boolean) ?? (p.status === "docked");
      this.location =
        (p.current_system as string) ||
        (p.location as string) ||
        this.location;

      // Ship fields
      const ship = r.ship as Record<string, unknown> | undefined;
      debugLog("bot:ship", `${this.username} ship object`, ship);
      if (ship) {
        this.shipName = (ship.name as string) || (ship.ship_type as string) || (ship.type as string) || this.shipName;
        this.fuel = (ship.fuel as number) ?? this.fuel;
        this.maxFuel = (ship.max_fuel as number) ?? this.maxFuel;
        this.cargo = (ship.cargo_used as number) ?? this.cargo;
        this.cargoMax = (ship.cargo_capacity as number) ?? (ship.max_cargo as number) ?? this.cargoMax;
        this.hull = (ship.hull as number) ?? (ship.hp as number) ?? this.hull;
        this.maxHull = (ship.max_hull as number) ?? (ship.max_hp as number) ?? this.maxHull;
        this.shield = (ship.shield as number) ?? (ship.shields as number) ?? this.shield;
        this.maxShield = (ship.max_shield as number) ?? (ship.max_shields as number) ?? this.maxShield;
        this.ammo = (ship.ammo as number) ?? this.ammo;
      }

      // Fallback: fuel at top level
      if (typeof r.fuel === "number") this.fuel = r.fuel;
    }

    // Also refresh cargo inventory (and storage only if docked)
    await this.refreshCargo();
    if (this.docked) {
      await this.refreshStorage();
    }

    return resp;
  }

  /** Parse an item list from API response, handling both item_id and resource_id formats. */
  private parseItemList(result: unknown): CargoItem[] {
    if (!result || typeof result !== "object") return [];

    const r = result as Record<string, unknown>;
    const items = (
      Array.isArray(r) ? r :
      Array.isArray(r.items) ? r.items :
      Array.isArray(r.cargo) ? r.cargo :
      Array.isArray(r.storage) ? r.storage :
      []
    ) as Array<Record<string, unknown>>;

    return items
      .map((item) => ({
        itemId: (item.item_id as string) || (item.resource_id as string) || (item.id as string) || "",
        name: (item.name as string) || (item.item_name as string) || (item.resource_name as string) || (item.item_id as string) || "",
        quantity: (item.quantity as number) || (item.count as number) || 0,
      }))
      .filter((i) => i.itemId && i.quantity > 0);
  }

  /** Fetch cargo contents and cache them. */
  async refreshCargo(): Promise<void> {
    const resp = await this.exec("get_cargo");
    // Always update inventory — even if response is empty/null, clear stale data
    this.inventory = this.parseItemList(resp.result);
  }

  /** Fetch station storage contents and cache them. */
  async refreshStorage(): Promise<void> {
    const resp = await this.exec("view_storage");
    this.storage = this.parseItemList(resp.result);
  }

  /** Start running a routine. */
  async start(
    routineName: string,
    routine: Routine,
    opts?: { getFleetStatus?: () => BotStatus[] },
  ): Promise<void> {
    if (this._state === "running") {
      this.log("error", "Bot is already running");
      return;
    }

    this._state = "running";
    this._routine = routineName;
    this._error = null;
    this._abortController = new AbortController();

    const loggedIn = await this.login();
    if (!loggedIn) return;

    this.log("system", `Starting routine: ${routineName}`);

    const ctx: RoutineContext = {
      api: this.api,
      bot: this,
      log: (cat, msg) => this.log(cat, msg),
      getFleetStatus: opts?.getFleetStatus,
    };

    try {
      for await (const stateName of routine(ctx)) {
        if ((this._state as BotState) === "stopping") {
          this.log("system", `Stopped during state: ${stateName}`);
          break;
        }
        // Small gap between actions
        await sleep(2000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._error = msg;
      this.log("error", `Routine error: ${msg}`);
      this._state = "error";
      return;
    }

    this._state = "idle";
    this._routine = null;
    this.log("system", "Routine finished");
  }

  /** Fetch skills and log any level-ups since the last check. */
  async checkSkills(): Promise<void> {
    const resp = await this.exec("get_skills");
    if (!resp.result || typeof resp.result !== "object") return;

    const r = resp.result as Record<string, unknown>;
    // Skills may be at top level or nested under .skills
    const skills = (
      Array.isArray(r) ? r :
      Array.isArray(r.skills) ? r.skills :
      []
    ) as Array<Record<string, unknown>>;

    for (const skill of skills) {
      const id = (skill.skill_id as string) || (skill.id as string) || (skill.name as string) || "";
      const name = (skill.name as string) || id;
      const level = (skill.level as number) ?? 0;
      if (!id) continue;

      const prev = this.skillLevels.get(id);
      if (prev !== undefined && level > prev) {
        this.log("skill", `LEVEL UP! ${name}: ${prev} -> ${level}`);
      }
      this.skillLevels.set(id, level);
    }
  }

  /** Signal the bot to stop after the current action. */
  stop(): void {
    if (this._state !== "running") return;
    this._state = "stopping";
    this._abortController?.abort();
    this.log("system", "Stop requested — will halt after current action");
  }

  /** Get a summary of the bot's current state. */
  status(): BotStatus {
    return {
      username: this.username,
      state: this._state,
      routine: this._routine,
      credits: this.credits,
      fuel: this.fuel,
      maxFuel: this.maxFuel,
      cargo: this.cargo,
      cargoMax: this.cargoMax,
      location: this.location,
      system: this.system,
      poi: this.poi,
      docked: this.docked,
      lastAction: this._lastAction,
      error: this._error,
      shipName: this.shipName,
      hull: this.hull,
      maxHull: this.maxHull,
      shield: this.shield,
      maxShield: this.maxShield,
      ammo: this.ammo,
      inventory: this.inventory,
      storage: this.storage,
    };
  }
}

const CATEGORY_COLORS: Record<string, string> = {
  system: "\x1b[34m",
  mining: "\x1b[32m",
  travel: "\x1b[36m",
  trade: "\x1b[33m",
  error: "\x1b[91m",
  info: "\x1b[37m",
  combat: "\x1b[31m",
  skill: "\x1b[95m",
  scavenge: "\x1b[33m",
  rescue: "\x1b[96m",
};

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || CATEGORY_COLORS.info;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
