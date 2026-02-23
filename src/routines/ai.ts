/**
 * AI routine — uses an LLM to play SpaceMolt autonomously.
 *
 * The LLM is given:
 *  - The official game documentation from https://game.spacemolt.com/skill.md
 *  - The bot's current game state
 *  - Persistent memory from data/ai_memory.json
 *  - Tools to query local map/catalog data and execute game commands
 *
 * Works with Ollama or any OpenAI-compatible endpoint.
 * Set OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY, or just run Ollama locally.
 */

import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { catalogStore } from "../catalogstore.js";
import { readSettings, sleep } from "./common.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ── Types ────────────────────────────────────────────────────

interface AiMemory {
  version: 1;
  lastCycle: string;
  cycleCount: number;
  goals: string[];
  insights: string[];
  decisions: Array<{ timestamp: string; action: string; reason: string }>;
}

interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ── Settings ─────────────────────────────────────────────────

function getAiSettings(): {
  model: string;
  baseUrl: string;
  apiKey: string;
  cycleIntervalSec: number;
  maxToolCallsPerCycle: number;
  captainsLogEveryN: number;
} {
  const all = readSettings();
  const s = (all.ai || {}) as Record<string, unknown>;

  const baseUrl =
    process.env.OPENAI_COMPAT_BASE_URL ||
    (s.baseUrl as string) ||
    "http://localhost:11434/v1";

  const apiKey =
    process.env.OPENAI_COMPAT_API_KEY ||
    (s.apiKey as string) ||
    "ollama";

  const model =
    process.env.AI_MODEL ||
    (s.model as string) ||
    "llama3.2";

  return {
    model,
    baseUrl,
    apiKey,
    cycleIntervalSec: (s.cycleIntervalSec as number) || 10,
    maxToolCallsPerCycle: (s.maxToolCallsPerCycle as number) || 40,
    captainsLogEveryN: (s.captainsLogEveryN as number) || 5,
  };
}

// ── Memory ────────────────────────────────────────────────────

const MEMORY_FILE = join(process.cwd(), "data", "ai_memory.json");

function loadMemory(): AiMemory {
  try {
    if (existsSync(MEMORY_FILE)) {
      return JSON.parse(readFileSync(MEMORY_FILE, "utf-8")) as AiMemory;
    }
  } catch { /* start fresh */ }
  return {
    version: 1,
    lastCycle: "",
    cycleCount: 0,
    goals: ["Play SpaceMolt effectively", "Earn credits and develop skills"],
    insights: [],
    decisions: [],
  };
}

function saveMemory(mem: AiMemory): void {
  const dir = join(process.cwd(), "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2) + "\n", "utf-8");
}

// ── Game documentation ────────────────────────────────────────

let cachedSkillMd: string | null = null;

async function fetchSkillMd(): Promise<string> {
  if (cachedSkillMd) return cachedSkillMd;
  try {
    const resp = await fetch("https://game.spacemolt.com/skill.md", {
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    cachedSkillMd = await resp.text();
    return cachedSkillMd;
  } catch {
    // Fallback minimal docs
    return [
      "# SpaceMolt — Quick Reference",
      "A multiplayer space MMO. Commands: undock, dock, travel(target_poi), jump(target_system),",
      "mine, buy(item_id, quantity), sell(item_id, quantity), get_status, get_system, get_poi,",
      "get_cargo, view_market, craft(recipe_id), chat(channel, content), captains_log_add(entry).",
      "Game loop: undock → travel to belt → mine → travel to station → dock → sell → refuel → repeat.",
    ].join("\n");
  }
}

// ── Live command list from OpenAPI spec ───────────────────────

let cachedCommandList: string | null = null;

async function fetchCommandList(): Promise<string> {
  if (cachedCommandList) return cachedCommandList;
  try {
    const resp = await fetch("https://game.spacemolt.com/api/v2/openapi.json", {
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const spec = await resp.json() as { paths?: Record<string, Record<string, { operationId?: string; summary?: string; "x-is-mutation"?: boolean }>> };
    const queries: string[] = [];
    const mutations: string[] = [];
    for (const methods of Object.values(spec.paths ?? {})) {
      const op = methods?.post;
      if (!op?.operationId || op.operationId === "createSession") continue;
      const label = op.summary ? `${op.operationId} — ${op.summary}` : op.operationId;
      if (op["x-is-mutation"]) mutations.push(label);
      else queries.push(label);
    }
    const lines: string[] = [];
    if (queries.length) lines.push(`Query commands (free, no tick cost):\n  ${queries.join("\n  ")}`);
    if (mutations.length) lines.push(`Action commands (costs 1 tick):\n  ${mutations.join("\n  ")}`);
    cachedCommandList = lines.join("\n\n");
    return cachedCommandList;
  } catch {
    return "(command list unavailable — use get_commands in-game)";
  }
}

// ── LLM client ───────────────────────────────────────────────

async function callLlm(
  messages: LlmMessage[],
  tools: ToolDefinition[],
  settings: ReturnType<typeof getAiSettings>,
): Promise<LlmMessage> {
  const url = `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`;

  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json() as {
    choices?: Array<{ message: LlmMessage; finish_reason: string }>;
    error?: { message: string };
  };

  if (data.error) throw new Error(`LLM error: ${data.error.message}`);
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error("LLM returned no message");
  return msg;
}

// ── Command cheatsheet injected into every prompt ─────────────
// skill.md uses informal notation (e.g. `travel(poi=)`); the actual API
// parameter names differ. This canonical reference prevents the LLM from
// guessing wrong parameter names.

// Critical param rules injected into every prompt — keeps the LLM from guessing wrong names.
const PARAM_RULES = `
## Critical Parameter Rules

- game_exec("travel", {target_poi: "poi_id"})   — target_poi = a POI id from get_system's "pois" array
- game_exec("jump",   {target_system: "sys_id"}) — target_system = an ADJACENT system id from get_system's "connections"
- game_exec("mine")  — NO parameters. Never pass target_poi or any params to mine.
- game_exec("sell",  {item_id: "ore_iron", quantity: 10}) — use the item's snake_case id, NOT its display name
- game_exec("buy",   {item_id: "item_id", quantity: 5})
- Must be UNDOCKED to travel/jump/mine; must be DOCKED to sell/buy/craft/refuel/repair
- MINE-ABLE poi types: asteroid_belt, gas_cloud, ice_field, nebula, resource_field
- NOT mine-able: sun, star, planet, station, wormhole, jump_gate
- mine() must be called multiple times to fill cargo — each call mines one batch
`.trim();

// ── Inline tool-call parser (fallback for models without proper function calling) ──
//
// Some models (e.g. llama3.2 via Ollama) output tool invocations as plain text
// instead of structured tool_calls. This parser extracts them so the loop can
// continue even without native function-calling support.

/** Extract all top-level JSON objects from a string (bracket-counting, handles nesting). */
function extractJsonObjects(text: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") { i++; continue; }
    let depth = 0;
    let inStr = false;
    let escaped = false;
    let j = i;
    while (j < text.length) {
      const c = text[j];
      if (escaped) { escaped = false; j++; continue; }
      if (c === "\\" && inStr) { escaped = true; j++; continue; }
      if (c === '"') { inStr = !inStr; j++; continue; }
      if (!inStr) {
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { j++; break; } }
      }
      j++;
    }
    try {
      results.push(JSON.parse(text.slice(i, j)) as Record<string, unknown>);
    } catch { /* not valid JSON */ }
    i = j;
  }
  return results;
}

interface InlineToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * Try to extract tool calls embedded in LLM text content.
 * Handles several formats emitted by smaller models:
 *   1. {"name": "<tool_desc_or_name>", "parameters": {...}}
 *   2. {"name": "<tool_name>", "arguments": {...}}
 *   3. ACTION: <tool_name>\nARGS: {...}
 *   4. Bare {"command": "...", "params": {...}}  → game_exec
 */
function parseInlineToolCalls(content: string, tools: ToolDefinition[]): InlineToolCall[] {
  const toolByName = new Map(tools.map(t => [t.function.name, t]));
  // Map first 40 chars of each tool description (lower) to name — catches models that use the description as "name"
  const descToName = new Map(
    tools.map(t => [t.function.description.toLowerCase().slice(0, 40), t.function.name])
  );

  const calls: InlineToolCall[] = [];
  let seq = 0;
  const makeId = () => `inline_${seq++}`;

  const push = (name: string, args: Record<string, unknown>) => {
    if (toolByName.has(name)) {
      calls.push({ id: makeId(), type: "function", function: { name, arguments: JSON.stringify(args) } });
    }
  };

  // Format 1 & 2: JSON objects with a "name" / ("parameters"|"arguments"|"args") pair
  for (const obj of extractJsonObjects(content)) {
    const rawName = (obj.name as string) || (obj.tool as string) || "";
    const args = (obj.parameters || obj.arguments || obj.args || obj.params || {}) as Record<string, unknown>;

    if (toolByName.has(rawName)) {
      push(rawName, args);
      continue;
    }
    // Fuzzy match: description prefix
    const descMatch = [...descToName.entries()].find(([desc]) =>
      rawName.toLowerCase().includes(desc.slice(0, 20))
    );
    if (descMatch) {
      push(descMatch[1], args);
      continue;
    }
    // Format 4: bare game_exec payload
    if (typeof obj.command === "string" && toolByName.has("game_exec")) {
      push("game_exec", obj);
    }
  }

  // Format 3: ACTION/TOOL line followed by ARGS/INPUT line
  const reactRe = /(?:ACTION|TOOL)\s*:\s*(\w+)\s*\n+(?:ARGS?|INPUT|PARAMETERS?)\s*:\s*(\{[\s\S]*?\})/gi;
  for (const m of content.matchAll(reactRe)) {
    const name = m[1];
    try { push(name, JSON.parse(m[2]) as Record<string, unknown>); } catch { /* skip */ }
  }

  // Format 4: word({...}) or word() — function-call style
  // Also handles abbreviations: min() → game_exec("mine"), get_stat() → game_exec("get_status"), etc.
  const COMMAND_ALIASES: Record<string, { tool: string; merge?: Record<string, unknown> }> = {
    min: { tool: "game_exec", merge: { command: "mine" } },
    mine: { tool: "game_exec", merge: { command: "mine" } },
    dock: { tool: "game_exec", merge: { command: "dock" } },
    undock: { tool: "game_exec", merge: { command: "undock" } },
    travel: { tool: "game_exec", merge: { command: "travel" } },
    jump: { tool: "game_exec", merge: { command: "jump" } },
    sell: { tool: "game_exec", merge: { command: "sell" } },
    buy: { tool: "game_exec", merge: { command: "buy" } },
    refuel: { tool: "game_exec", merge: { command: "refuel" } },
    repair: { tool: "game_exec", merge: { command: "repair" } },
    get_status: { tool: "game_exec", merge: { command: "get_status" } },
    get_system: { tool: "game_exec", merge: { command: "get_system" } },
    get_cargo: { tool: "game_exec", merge: { command: "get_cargo" } },
    view_market: { tool: "game_exec", merge: { command: "view_market" } },
    chat: { tool: "game_exec", merge: { command: "chat" } },
    survey_system: { tool: "game_exec", merge: { command: "survey_system" } },
  };

  const fnCallRe = /\b(\w+)\s*\(\s*(\{[^)]*\}|\{\s*\})?\s*\)/g;
  for (const m of content.matchAll(fnCallRe)) {
    const word = m[1].toLowerCase();
    let argsStr = m[2] || "{}";
    // Skip obvious non-tool words
    if (["if", "for", "while", "function", "return", "const", "let", "var", "class"].includes(word)) continue;
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsStr) as Record<string, unknown>; } catch { /* ignore malformed */ }

    const alias = COMMAND_ALIASES[word];
    if (alias) {
      // Strip any nested params wrapper
      const inner = (args.params || args) as Record<string, unknown>;
      push(alias.tool, { ...alias.merge, params: Object.keys(inner).length ? inner : undefined });
    } else if (toolByName.has(word)) {
      push(word, args);
    }
  }

  return calls;
}

// ── Tool implementations ──────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>, ctx: RoutineContext) => Promise<string>;

/** Compact-stringify a value, truncating to maxLen chars. */
function compact(value: unknown, maxLen = 2000): string {
  const s = JSON.stringify(value);
  return s.length > maxLen ? s.slice(0, maxLen) + "…[truncated]" : s;
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  /** Execute any SpaceMolt game command via the bot's API connection. */
  game_exec: async (args, ctx) => {
    const command = args.command as string;
    if (!command) return compact({ error: "command is required" });
    const params = (args.params ?? {}) as Record<string, unknown>;

    // Common mistake guard: travel/jump with wrong param names
    if (command === "travel" && !params.target_poi) {
      return compact({
        error: "travel requires {target_poi: 'poi_id'}. Call game_exec('get_system') first to see POI ids.",
        hint: "Example: game_exec('travel', {target_poi: 'belt_0215_1'})",
      });
    }
    if (command === "jump" && !params.target_system) {
      return compact({
        error: "jump requires {target_system: 'sys_id'}. Call game_exec('get_system') to see adjacent system ids.",
        hint: "Example: game_exec('jump', {target_system: 'sys_0042'})",
      });
    }

    const resp = await ctx.bot.exec(command, params);
    if (resp.error) {
      return compact({ error: resp.error.message, code: resp.error.code });
    }
    return compact(resp.result);
  },

  /** Get locally-stored data for a star system. */
  map_get_system: async (args) => {
    const sys = mapStore.getSystem(args.system_id as string);
    if (!sys) return compact({ error: `System '${args.system_id}' not in local map yet — use game_exec get_system to fetch it` });
    return compact({
      id: sys.id,
      name: sys.name,
      security_level: sys.security_level,
      connections: sys.connections.map(c => ({ id: c.system_id, name: c.system_name, jump_cost: c.jump_cost })),
      pois: sys.pois.map(p => ({
        id: p.id, name: p.name, type: p.type, has_base: p.has_base,
        ores_found: p.ores_found.map(o => o.name || o.item_id),
        market_item_count: p.market.length,
      })),
    });
  },

  /** Find all known locations where a specific ore has been mined. */
  map_find_ore_locations: async (args) => {
    const locs = mapStore.findOreLocations(args.ore_id as string);
    if (locs.length === 0) return compact({ error: `No known locations for '${args.ore_id}'` });
    return compact(locs.slice(0, 10));
  },

  /** Find arbitrage trade opportunities (buy low somewhere, sell high elsewhere). */
  map_get_price_spreads: async (args) => {
    const spreads = mapStore.findPriceSpreads(args.item_id as string | undefined);
    return compact(spreads.slice(0, 15));
  },

  /** Find a route between two systems using the local galaxy map. */
  map_find_route: async (args) => {
    const route = mapStore.findRoute(args.from_system as string, args.to_system as string);
    if (!route) return compact({ error: `No known route from '${args.from_system}' to '${args.to_system}'` });
    return compact({ route, hops: route.length - 1 });
  },

  /** List all ore types observed anywhere in the galaxy. */
  map_get_all_known_ores: async () => {
    return compact(mapStore.getAllKnownOres());
  },

  /** Get items that stations want to buy (buy orders), sorted by best price. */
  map_get_buy_demand: async () => {
    const demand = mapStore.getAllBuyDemand()
      .sort((a, b) => b.price - a.price)
      .slice(0, 20);
    return compact(demand);
  },

  /** Find the station offering the best sell price for an item. */
  map_find_best_sell_price: async (args) => {
    const result = mapStore.findBestSellPrice(args.item_id as string);
    if (!result) return compact({ error: `No sell price data for '${args.item_id}'` });
    return compact(result);
  },

  /** Look up game catalog data (items, ships, skills, recipes). */
  catalog_lookup: async (args) => {
    const type = args.type as string;
    const id = args.id as string;
    let result: unknown;
    if (type === "item") result = catalogStore.getItem(id);
    else if (type === "ship") result = catalogStore.getShip(id);
    else if (type === "skill") result = catalogStore.getSkill(id);
    else if (type === "recipe") result = catalogStore.getRecipe(id);
    else return compact({ error: `Unknown type '${type}' — use item, ship, skill, or recipe` });
    if (!result) return compact({ error: `${type} not found: '${id}'` });
    return compact(result);
  },

  /** Update persistent AI memory: goals, insights, and past decisions. */
  memory_update: async (args) => {
    const mem = loadMemory();
    if (Array.isArray(args.goals)) {
      mem.goals = (args.goals as string[]).slice(0, 5);
    }
    if (typeof args.insight === "string" && args.insight) {
      mem.insights.unshift(args.insight);
      if (mem.insights.length > 20) mem.insights = mem.insights.slice(0, 20);
    }
    if (typeof args.decision === "string" && args.decision) {
      mem.decisions.unshift({
        timestamp: new Date().toISOString(),
        action: args.decision,
        reason: (args.reason as string) || "",
      });
      if (mem.decisions.length > 30) mem.decisions = mem.decisions.slice(0, 30);
    }
    saveMemory(mem);
    return compact({ ok: true });
  },
};

// ── Tool schema definitions ───────────────────────────────────

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "game_exec",
      description:
        "Execute a SpaceMolt game command. Use this for all gameplay: travel, mine, dock, undock, " +
        "sell, buy, craft, chat, get_status, get_system, get_poi, view_market, get_cargo, refuel, repair, etc.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Command name (e.g. 'travel', 'mine', 'dock', 'get_status', 'view_market')",
          },
          params: {
            type: "object",
            description: "Command parameters (e.g. {target_poi: 'belt_id'} for travel, {item_id: 'ore_iron', quantity: 10} for sell)",
            additionalProperties: true,
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "map_get_system",
      description: "Look up locally cached data about a star system: POIs, connections, ores, market item count.",
      parameters: {
        type: "object",
        properties: {
          system_id: { type: "string", description: "The system ID (e.g. 'sol', 'sirius')" },
        },
        required: ["system_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "map_find_ore_locations",
      description: "Find all known locations where a specific ore has been mined (from local map data).",
      parameters: {
        type: "object",
        properties: {
          ore_id: { type: "string", description: "Ore item ID (e.g. 'ore_iron', 'ore_vanadium')" },
        },
        required: ["ore_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "map_get_price_spreads",
      description:
        "Find trade arbitrage opportunities: items that can be bought cheaply at one station and " +
        "sold at a higher price at another. Returns top opportunities sorted by profit spread.",
      parameters: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "Optional: filter to one item. Omit to get all opportunities.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "map_find_route",
      description: "Find a route between two systems using the local galaxy map (BFS pathfinding).",
      parameters: {
        type: "object",
        properties: {
          from_system: { type: "string", description: "Starting system ID" },
          to_system: { type: "string", description: "Destination system ID" },
        },
        required: ["from_system", "to_system"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "map_get_all_known_ores",
      description: "List all ore types that have been observed in the galaxy (from local exploration data).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "map_get_buy_demand",
      description: "Get items that stations want to buy (have active buy orders), sorted by highest price. Useful for deciding what to mine or produce.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "map_find_best_sell_price",
      description: "Find the station across the known galaxy offering the highest sell price for a specific item.",
      parameters: {
        type: "object",
        properties: {
          item_id: { type: "string", description: "The item ID to look up" },
        },
        required: ["item_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "catalog_lookup",
      description: "Look up game reference data: items, ships, skills, or crafting recipes by ID.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["item", "ship", "skill", "recipe"],
            description: "What kind of data to look up",
          },
          id: { type: "string", description: "The ID to look up" },
        },
        required: ["type", "id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_update",
      description:
        "Update your persistent memory that survives across play sessions. " +
        "Use this to record goals, key discoveries, and important decisions.",
      parameters: {
        type: "object",
        properties: {
          goals: {
            type: "array",
            items: { type: "string" },
            description: "Replace your goal list (up to 5 goals)",
          },
          insight: {
            type: "string",
            description: "A new insight to remember (e.g. 'Iron ore sells well at Kepler Station')",
          },
          decision: {
            type: "string",
            description: "A key decision you made this cycle",
          },
          reason: {
            type: "string",
            description: "Why you made this decision",
          },
        },
        required: [],
      },
    },
  },
];

// ── Routine ───────────────────────────────────────────────────

export const aiRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  // ── Load game documentation and command list ──
  ctx.log("ai", "Fetching game documentation and command list...");
  const [skillMd, commandList] = await Promise.all([fetchSkillMd(), fetchCommandList()]);
  ctx.log("ai", `Game docs loaded (${skillMd.length} chars). Starting AI play loop.`);

  yield "init";
  await bot.refreshStatus();

  while (bot.state === "running") {
    const settings = getAiSettings();

    if (!settings.baseUrl) {
      ctx.log("error", "OPENAI_COMPAT_BASE_URL not set and Ollama default unreachable — set env var to enable AI routine");
      await sleep(60_000);
      continue;
    }

    const mem = loadMemory();
    mem.cycleCount++;
    mem.lastCycle = new Date().toISOString();

    yield "ai_cycle";

    ctx.log("ai", `Cycle #${mem.cycleCount} — model: ${settings.model} @ ${settings.baseUrl}`);

    // ── Gather current state ──
    await bot.refreshStatus();

    const statusSummary = [
      `Credits: ${bot.credits}`,
      `System: ${bot.system}`,
      `POI: ${bot.poi || "unknown"}`,
      `Docked: ${bot.docked}`,
      `Fuel: ${bot.fuel}/${bot.maxFuel}`,
      `Hull: ${bot.hull}/${bot.maxHull}`,
      `Shield: ${bot.shield}/${bot.maxShield}`,
      `Cargo: ${bot.cargo}/${bot.cargoMax}`,
      `Inventory: ${bot.inventory.length > 0 ? bot.inventory.map(i => `${i.quantity}x ${i.name}`).join(", ") : "empty"}`,
      `Storage: ${bot.storage.length > 0 ? bot.storage.map(i => `${i.quantity}x ${i.name}`).join(", ") : "empty"}`,
    ].join(" | ");

    const memLines = [
      `Goals: ${mem.goals.slice(0, 3).join("; ")}`,
      mem.insights.length > 0 ? `Insights: ${mem.insights.slice(0, 3).join("; ")}` : null,
      mem.decisions.length > 0 ? `Last decision: ${mem.decisions[0].action}` : null,
    ].filter(Boolean).join("\n");

    // ── Current system's known POIs (saves an API call) ──
    const knownSystem = mapStore.getSystem(bot.system);
    const knownPois = knownSystem?.pois.map(p =>
      `  ${p.id} — ${p.name} (${p.type})${p.has_base ? " [STATION]" : ""}${p.ores_found.length ? ` [ores: ${p.ores_found.map(o => o.name || o.item_id).join(", ")}]` : ""}`
    ).join("\n") || "  (not yet scanned — call get_system first)";

    // ── Recent action log (cross-cycle context) ──
    const recentLog = bot.actionLog.slice(-15).join("\n");

    // ── Build messages ──
    const systemPrompt = [
      "You are an AI agent playing SpaceMolt, a multiplayer space MMO. Here is the game documentation:",
      "",
      skillMd,
      "",
      "---",
      "",
      "## Available Game Commands",
      commandList,
      "",
      "---",
      "",
      PARAM_RULES,
      "",
      "---",
      "",
      "TOOLS AVAILABLE:",
      "  game_exec(command, params?)   — execute game commands (see command list above)",
      "  map_get_system(system_id)     — cached POI/connection info for a system",
      "  map_find_ore_locations(ore_id)",
      "  map_get_price_spreads(item_id?)",
      "  map_find_route(from_system, to_system)",
      "  map_get_all_known_ores()",
      "  map_get_buy_demand()",
      "  map_find_best_sell_price(item_id)",
      "  catalog_lookup(type, id)      — type = item | ship | skill | recipe",
      "  memory_update(goals?, insight?, decision?, reason?)",
      "",
      "BEHAVIOUR RULES:",
      "  1. Always EXECUTE actions — never just describe what you plan to do.",
      "  2. After any error, immediately retry with corrected parameters.",
      "  3. Complete a full activity loop: check state → travel → act → return → sell/deposit.",
      "  4. Call mine() multiple times in a row to fill your cargo hold.",
      "  5. Save insights and decisions with memory_update before finishing.",
      "",
      "IF YOUR TOOL CALLS ARE NOT BEING RECOGNISED, output them as plain JSON instead:",
      '  {"name": "game_exec", "parameters": {"command": "travel", "params": {"target_poi": "poi_id"}}}',
      "One JSON object per line, or wrap multiple in an array.",
    ].join("\n");

    const userMessage = [
      `## Your Current State`,
      statusSummary,
      ``,
      `## Known POIs in ${bot.system || "current system"}`,
      knownPois,
      ``,
      `## Your Memory`,
      memLines,
      ``,
      `## Recent Activity Log`,
      recentLog || "(no recent activity)",
      ``,
      `## Instructions`,
      "Play SpaceMolt right now. Use tools to take REAL actions — do not describe plans.",
      "Pick a mine-able POI from the list above, travel there, mine repeatedly, then return to a station to sell.",
      "mine() takes NO parameters. Never pass target_poi or any params to mine().",
      "When you have genuinely finished a round of gameplay, summarise what you achieved.",
    ].join("\n");

    // system + user are always kept; tool exchange window = last N assistant+tool pairs
    const WINDOW_PAIRS = 8; // keep last 8 assistant↔tool-result exchanges (~16 messages)
    const anchorMessages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];
    // sliding window holds only the recent tool exchange messages
    let window: LlmMessage[] = [];
    const buildMessages = () => [...anchorMessages, ...window];

    // ── Agentic tool-call loop ──
    let toolCallCount = 0;
    let lastText = "";
    let nudgeCount = 0;
    const MAX_NUDGES = 2;

    try {
      while (toolCallCount < settings.maxToolCallsPerCycle && bot.state === "running") {
        const response = await callLlm(buildMessages(), TOOLS, settings);
        window.push(response);

        if (response.content) {
          lastText = response.content;
        }

        // Fallback: if no structured tool_calls, try to parse inline calls from text
        if ((!response.tool_calls || response.tool_calls.length === 0) && response.content) {
          const inlineCalls = parseInlineToolCalls(response.content, TOOLS);
          if (inlineCalls.length > 0) {
            ctx.log("ai", `Parsed ${inlineCalls.length} inline tool call(s) from text`);
            response.tool_calls = inlineCalls;
          }
        }

        // No tool calls → nudge the LLM to keep acting, or end the cycle
        if (!response.tool_calls || response.tool_calls.length === 0) {
          if (nudgeCount < MAX_NUDGES) {
            nudgeCount++;
            ctx.log("ai", `No tool calls — nudging (${nudgeCount}/${MAX_NUDGES})`);
            window.push({ role: "user", content: "Continue your mission. Take the next action using tools. Do not describe plans — execute them." });
            continue;
          }
          ctx.log("ai", `Done: ${lastText.slice(0, 300)}`);
          break;
        }

        nudgeCount = 0; // reset nudge count whenever the LLM does call a tool

        // Execute each tool call and feed results back
        for (const tc of response.tool_calls) {
          let toolResult: string;
          try {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* empty */ }

            const handler = TOOL_HANDLERS[tc.function.name];
            if (!handler) {
              toolResult = compact({ error: `Unknown tool: ${tc.function.name}` });
            } else {
              ctx.log("ai", `→ ${tc.function.name}(${tc.function.arguments.slice(0, 120)})`);
              toolResult = await handler(args, ctx);
            }
          } catch (err) {
            toolResult = compact({ error: err instanceof Error ? err.message : String(err) });
          }

          toolCallCount++;
          window.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.function.name,
            content: toolResult,
          });
        }

        // Trim window: keep only the last WINDOW_PAIRS assistant+tool-result pairs.
        // Each pair = 1 assistant message (possibly with multiple tool_calls) + N tool messages.
        // Walk back from the end to find the cut point.
        let pairs = 0;
        let cutIdx = window.length;
        for (let i = window.length - 1; i >= 0; i--) {
          if (window[i].role === "assistant") {
            pairs++;
            if (pairs > WINDOW_PAIRS) { cutIdx = i; break; }
          }
        }
        if (cutIdx < window.length) window = window.slice(cutIdx);

        yield "ai_tool";
        await sleep(500); // brief pause between tool batches
      }

      if (toolCallCount >= settings.maxToolCallsPerCycle) {
        ctx.log("ai", `Tool call limit (${settings.maxToolCallsPerCycle}) reached this cycle`);
      }
    } catch (err) {
      ctx.log("error", `AI cycle error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Save cycle metadata without overwriting insights/goals written by memory_update tool
    const latestMem = loadMemory();
    latestMem.cycleCount = mem.cycleCount;
    latestMem.lastCycle = mem.lastCycle;
    saveMemory(latestMem);

    // Write captain's log every N cycles
    if (mem.cycleCount % settings.captainsLogEveryN === 0 && lastText) {
      const entry = `AI Cycle ${mem.cycleCount} — ${lastText.slice(0, 400)}`;
      try {
        await bot.exec("captains_log_add", { entry });
        ctx.log("ai", "Captain's log updated");
      } catch { /* non-fatal */ }
    }

    ctx.log("ai", `Cycle #${mem.cycleCount} complete. Sleeping ${settings.cycleIntervalSec}s...`);
    await sleep(settings.cycleIntervalSec * 1000);
  }
};
