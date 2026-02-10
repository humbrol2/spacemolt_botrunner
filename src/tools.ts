import { Type, StringEnum } from "@mariozechner/pi-ai";
import type { Tool } from "@mariozechner/pi-ai";
import type { SpaceMoltAPI, ApiResponse } from "./api.js";
import type { SessionManager, Credentials } from "./session.js";
import { log, logTool, formatToolResult } from "./ui.js";

// ─── Helper factories ────────────────────────────────────────

function simpleTool(name: string, description: string): Tool {
  return { name, description, parameters: Type.Object({}) };
}

function paramTool(name: string, description: string, parameters: any): Tool {
  return { name, description, parameters };
}

// ─── Tool Definitions ────────────────────────────────────────

export const allTools: Tool[] = [
  // ── Authentication ──
  paramTool("register", "Register a new player account. Choose a unique username and empire.", Type.Object({
    username: Type.String({ description: "Globally unique username" }),
    empire: StringEnum(["solarian", "voidborn", "crimson", "nebula", "outerrim"], {
      description: "Empire to join: solarian (mining/trade), voidborn (stealth/shields), crimson (combat), nebula (exploration), outerrim (crafting/cargo)",
    }),
  })),
  paramTool("login", "Login with existing credentials.", Type.Object({
    username: Type.String({ description: "Your username" }),
    password: Type.String({ description: "Your 256-bit hex password" }),
  })),
  simpleTool("logout", "Disconnect cleanly from the server."),

  // ── Navigation ──
  paramTool("travel", "Travel to a POI within your current system. Takes time based on distance.", Type.Object({
    target_poi: Type.String({ description: "POI ID to travel to" }),
  })),
  paramTool("jump", "Jump to an adjacent system. Costs 2 fuel and takes 2 ticks.", Type.Object({
    target_system: Type.String({ description: "System ID to jump to" }),
  })),
  simpleTool("dock", "Dock at the base at your current POI."),
  simpleTool("undock", "Undock and leave the station."),
  paramTool("search_systems", "Search for systems by name.", Type.Object({
    query: Type.String({ description: "System name search query" }),
  })),
  paramTool("find_route", "Find the shortest route to a target system.", Type.Object({
    target_system: Type.String({ description: "Target system ID" }),
  })),

  // ── Mining & Resources ──
  simpleTool("mine", "Mine resources at your current POI (must be at an asteroid belt or similar)."),
  simpleTool("refuel", "Refuel your ship at a station (must be docked)."),
  simpleTool("repair", "Repair your ship at a station (must be docked)."),
  paramTool("jettison", "Jettison cargo into space (creates a lootable container).", Type.Object({
    item_id: Type.String({ description: "Item ID to jettison" }),
    quantity: Type.Number({ description: "Quantity to jettison" }),
  })),

  // ── Trading ──
  paramTool("buy", "Buy items at market price (fills cheapest sell orders). Must be docked.", Type.Object({
    item_id: Type.String({ description: "Item ID to buy" }),
    quantity: Type.Number({ description: "Quantity to buy" }),
  })),
  paramTool("sell", "Sell items at market price (fills highest buy orders). Must be docked.", Type.Object({
    item_id: Type.String({ description: "Item ID to sell" }),
    quantity: Type.Number({ description: "Quantity to sell" }),
  })),
  simpleTool("get_listings", "View market listings at the current base (exchange + NPC prices)."),
  paramTool("create_sell_order", "List items for sale on the exchange (items are escrowed).", Type.Object({
    item_id: Type.String({ description: "Item ID to sell" }),
    quantity: Type.Number({ description: "Quantity to sell" }),
    price_each: Type.Number({ description: "Price per unit in credits" }),
  })),
  paramTool("create_buy_order", "Place a standing buy order (credits are escrowed).", Type.Object({
    item_id: Type.String({ description: "Item ID to buy" }),
    quantity: Type.Number({ description: "Quantity to buy" }),
    price_each: Type.Number({ description: "Price per unit in credits" }),
  })),
  paramTool("view_market", "View the order book for an item (buy/sell orders by price).", Type.Object({
    item_id: Type.Optional(Type.String({ description: "Item ID to view (optional, shows all if omitted)" })),
  })),
  simpleTool("view_orders", "View your active exchange orders."),
  paramTool("cancel_order", "Cancel an exchange order and return escrowed items/credits.", Type.Object({
    order_id: Type.String({ description: "Order ID to cancel" }),
  })),
  paramTool("modify_order", "Change the price of an existing exchange order.", Type.Object({
    order_id: Type.String({ description: "Order ID to modify" }),
    new_price: Type.Number({ description: "New price per unit" }),
  })),
  paramTool("estimate_purchase", "Preview the total cost of buying an item (read-only).", Type.Object({
    item_id: Type.String({ description: "Item ID" }),
    quantity: Type.Number({ description: "Quantity" }),
  })),

  // ── Combat ──
  paramTool("attack", "Attack a player or NPC with a weapon.", Type.Object({
    target_id: Type.String({ description: "Target player or NPC ID" }),
    weapon_idx: Type.Number({ description: "Weapon module slot index (0-based)" }),
  })),
  paramTool("scan", "Scan a player to reveal information about them.", Type.Object({
    target_id: Type.String({ description: "Target player ID" }),
  })),
  paramTool("cloak", "Toggle your cloaking device (consumes fuel while active).", Type.Object({
    enable: Type.Boolean({ description: "true to enable, false to disable" }),
  })),
  simpleTool("self_destruct", "Self-destruct your ship. Use with extreme caution."),

  // ── Ship Management ──
  simpleTool("get_ships", "Browse all available ship classes for purchase."),
  paramTool("buy_ship", "Purchase a new ship. Your current ship is stored at the base.", Type.Object({
    ship_class: Type.String({ description: "Ship class ID to buy" }),
  })),
  paramTool("sell_ship", "Sell a stored ship.", Type.Object({
    ship_id: Type.String({ description: "Ship ID to sell" }),
  })),
  simpleTool("list_ships", "List all ships you own."),
  paramTool("switch_ship", "Switch to a stored ship at the current base.", Type.Object({
    ship_id: Type.String({ description: "Ship ID to switch to" }),
  })),
  paramTool("install_mod", "Install a module into a ship slot.", Type.Object({
    module_id: Type.String({ description: "Module item ID to install" }),
    slot_idx: Type.Number({ description: "Slot index to install into" }),
  })),
  paramTool("uninstall_mod", "Remove an installed module from your ship.", Type.Object({
    module_id: Type.String({ description: "Module ID to uninstall" }),
  })),

  // ── Crafting ──
  paramTool("craft", "Craft an item using a recipe (must be docked, have skill + materials).", Type.Object({
    recipe_id: Type.String({ description: "Recipe ID to craft" }),
  })),
  simpleTool("get_recipes", "View available crafting recipes."),

  // ── Wrecks & Salvage ──
  simpleTool("get_wrecks", "List all wrecks at your current POI."),
  paramTool("loot_wreck", "Take items from a wreck into your cargo.", Type.Object({
    wreck_id: Type.String({ description: "Wreck ID" }),
    item_id: Type.String({ description: "Item ID to loot" }),
    quantity: Type.Number({ description: "Quantity to take" }),
  })),
  paramTool("salvage_wreck", "Salvage a wreck for raw materials (destroys the wreck).", Type.Object({
    wreck_id: Type.String({ description: "Wreck ID to salvage" }),
  })),

  // ── Chat ──
  paramTool("chat", "Send a chat message.", Type.Object({
    channel: StringEnum(["local", "system", "faction", "private"], {
      description: "Chat channel",
    }),
    content: Type.String({ description: "Message to send" }),
    target_id: Type.Optional(Type.String({ description: "Target player ID (required for private)" })),
  })),
  paramTool("get_chat_history", "Get recent chat messages from a channel.", Type.Object({
    channel: StringEnum(["local", "system", "faction", "private"], {
      description: "Chat channel",
    }),
    limit: Type.Optional(Type.Number({ description: "Max messages to return (default 50)" })),
  })),

  // ── Factions ──
  paramTool("create_faction", "Create a new faction.", Type.Object({
    name: Type.String({ description: "Faction name" }),
    tag: Type.String({ description: "4-character faction tag" }),
  })),
  paramTool("join_faction", "Accept a faction invitation.", Type.Object({
    faction_id: Type.String({ description: "Faction ID to join" }),
  })),
  simpleTool("leave_faction", "Leave your current faction."),
  paramTool("faction_invite", "Invite a player to your faction.", Type.Object({
    player_id: Type.String({ description: "Player ID to invite" }),
  })),
  paramTool("faction_kick", "Remove a member from your faction.", Type.Object({
    player_id: Type.String({ description: "Player ID to kick" }),
  })),
  paramTool("faction_info", "View faction details.", Type.Object({
    faction_id: Type.Optional(Type.String({ description: "Faction ID (omit for your faction)" })),
  })),
  paramTool("faction_list", "Browse all factions.", Type.Object({
    limit: Type.Optional(Type.Number({ description: "Max results" })),
    offset: Type.Optional(Type.Number({ description: "Offset for pagination" })),
  })),
  paramTool("faction_set_ally", "Mark a faction as an ally.", Type.Object({
    target_faction_id: Type.String({ description: "Faction ID" }),
  })),
  paramTool("faction_set_enemy", "Mark a faction as an enemy.", Type.Object({
    target_faction_id: Type.String({ description: "Faction ID" }),
  })),
  paramTool("faction_declare_war", "Declare war on a faction.", Type.Object({
    target_faction_id: Type.String({ description: "Target faction ID" }),
    reason: Type.String({ description: "Reason for war declaration" }),
  })),

  // ── Player-to-Player Trading ──
  paramTool("trade_offer", "Propose a trade with another player (both must be docked at same POI).", Type.Object({
    target_id: Type.String({ description: "Target player ID" }),
    offer_items: Type.Optional(Type.Array(Type.Object({
      item_id: Type.String(),
      quantity: Type.Number(),
    }), { description: "Items you offer" })),
    offer_credits: Type.Optional(Type.Number({ description: "Credits you offer" })),
    request_items: Type.Optional(Type.Array(Type.Object({
      item_id: Type.String(),
      quantity: Type.Number(),
    }), { description: "Items you request" })),
    request_credits: Type.Optional(Type.Number({ description: "Credits you request" })),
  })),
  paramTool("trade_accept", "Accept a pending trade offer.", Type.Object({
    trade_id: Type.String({ description: "Trade ID to accept" }),
  })),
  paramTool("trade_decline", "Decline a pending trade offer.", Type.Object({
    trade_id: Type.String({ description: "Trade ID to decline" }),
  })),
  paramTool("trade_cancel", "Cancel your outgoing trade offer.", Type.Object({
    trade_id: Type.String({ description: "Trade ID to cancel" }),
  })),
  simpleTool("get_trades", "View your pending incoming and outgoing trade offers."),

  // ── Base Building ──
  paramTool("build_base", "Build a base at the current POI.", Type.Object({
    name: Type.String({ description: "Base name" }),
    type: StringEnum(["station"], { description: "Base type" }),
    services: Type.Array(Type.String(), { description: "Services to include" }),
  })),
  simpleTool("get_base_cost", "View the cost to build a base."),
  paramTool("attack_base", "Initiate a raid on a base.", Type.Object({
    base_id: Type.String({ description: "Base ID to attack" }),
  })),
  simpleTool("raid_status", "View active raids."),
  simpleTool("get_base_wrecks", "List base wrecks at current POI."),
  paramTool("loot_base_wreck", "Loot a base wreck.", Type.Object({
    wreck_id: Type.String({ description: "Wreck ID" }),
    item_id: Type.String({ description: "Item ID" }),
    quantity: Type.Number({ description: "Quantity" }),
  })),
  paramTool("salvage_base_wreck", "Salvage a base wreck for materials.", Type.Object({
    wreck_id: Type.String({ description: "Wreck ID" }),
  })),

  // ── Drones ──
  paramTool("deploy_drone", "Deploy a drone from your cargo.", Type.Object({
    drone_item_id: Type.String({ description: "Drone item ID" }),
    target_id: Type.Optional(Type.String({ description: "Target ID for the drone" })),
  })),
  paramTool("recall_drone", "Recall deployed drones.", Type.Object({
    all: Type.Optional(Type.Boolean({ description: "Recall all drones" })),
    drone_id: Type.Optional(Type.String({ description: "Specific drone ID" })),
  })),
  paramTool("order_drone", "Give orders to a deployed drone.", Type.Object({
    command: Type.String({ description: "Command for the drone" }),
    target_id: Type.Optional(Type.String({ description: "Target ID" })),
  })),
  simpleTool("get_drones", "View your deployed drones."),

  // ── Missions ──
  simpleTool("get_missions", "Get available missions at the current base (must be docked)."),
  paramTool("accept_mission", "Accept a mission.", Type.Object({
    mission_id: Type.String({ description: "Mission ID to accept" }),
  })),
  paramTool("complete_mission", "Complete a mission and claim reward.", Type.Object({
    mission_id: Type.String({ description: "Mission ID" }),
  })),
  simpleTool("get_active_missions", "View your active missions."),
  paramTool("abandon_mission", "Abandon an active mission.", Type.Object({
    mission_id: Type.String({ description: "Mission ID to abandon" }),
  })),

  // ── Forum ──
  paramTool("forum_list", "List forum threads.", Type.Object({
    page: Type.Optional(Type.Number({ description: "Page number (0-based)" })),
    category: Type.Optional(Type.String({ description: "Category filter" })),
  })),
  paramTool("forum_get_thread", "Read a forum thread.", Type.Object({
    thread_id: Type.String({ description: "Thread ID" }),
  })),
  paramTool("forum_create_thread", "Create a new forum thread.", Type.Object({
    title: Type.String({ description: "Thread title" }),
    content: Type.String({ description: "Thread body" }),
    category: Type.Optional(Type.String({ description: "Category" })),
  })),
  paramTool("forum_reply", "Reply to a forum thread.", Type.Object({
    thread_id: Type.String({ description: "Thread ID" }),
    content: Type.String({ description: "Reply content" }),
  })),
  paramTool("forum_upvote", "Upvote a thread or reply.", Type.Object({
    thread_id: Type.Optional(Type.String({ description: "Thread ID to upvote" })),
    reply_id: Type.Optional(Type.String({ description: "Reply ID to upvote" })),
  })),

  // ── Captain's Log ──
  paramTool("captains_log_add", "Add an entry to your captain's log. Use this to record goals and events.", Type.Object({
    entry: Type.String({ description: "Log entry text" }),
  })),
  simpleTool("captains_log_list", "List all captain's log entries."),
  paramTool("captains_log_get", "Get a specific captain's log entry.", Type.Object({
    index: Type.Number({ description: "Entry index" }),
  })),

  // ── Station Storage ──
  simpleTool("view_storage", "View your storage at the current station."),
  paramTool("deposit_items", "Deposit items into station storage.", Type.Object({
    item_id: Type.String({ description: "Item ID" }),
    quantity: Type.Number({ description: "Quantity" }),
  })),
  paramTool("withdraw_items", "Withdraw items from station storage.", Type.Object({
    item_id: Type.String({ description: "Item ID" }),
    quantity: Type.Number({ description: "Quantity" }),
  })),
  paramTool("deposit_credits", "Deposit credits into station storage.", Type.Object({
    amount: Type.Number({ description: "Amount of credits" }),
  })),
  paramTool("withdraw_credits", "Withdraw credits from station storage.", Type.Object({
    amount: Type.Number({ description: "Amount of credits" }),
  })),
  paramTool("send_gift", "Send a gift to another player (async delivery).", Type.Object({
    recipient: Type.String({ description: "Recipient username" }),
    item_id: Type.Optional(Type.String({ description: "Item ID to send" })),
    quantity: Type.Optional(Type.Number({ description: "Item quantity" })),
    credits: Type.Optional(Type.Number({ description: "Credits to send" })),
    message: Type.Optional(Type.String({ description: "Gift message" })),
  })),

  // ── Information Queries (unlimited) ──
  simpleTool("get_status", "Get your current player and ship status. Use this often!"),
  simpleTool("get_system", "Get info about your current system (POIs, connections, police level)."),
  simpleTool("get_poi", "Get detailed info about your current POI."),
  simpleTool("get_base", "Get info about the base you're docked at."),
  simpleTool("get_ship", "Get detailed info about your current ship (modules, stats)."),
  simpleTool("get_cargo", "Get your cargo contents."),
  simpleTool("get_nearby", "See other players and NPCs at your current POI."),
  simpleTool("get_skills", "View your full skill tree and progress."),
  simpleTool("get_version", "Get the server version and release notes."),
  paramTool("get_map", "Get galaxy map info.", Type.Object({
    system_id: Type.Optional(Type.String({ description: "Specific system ID (omit for all known)" })),
  })),
  paramTool("help", "Get help on a specific command or topic.", Type.Object({
    topic: Type.Optional(Type.String({ description: "Command or topic name" })),
  })),
  simpleTool("get_commands", "Get a structured list of all available commands."),

  // ── Local Tools (not sent to server) ──
  paramTool("save_credentials", "Save your login credentials locally. Do this IMMEDIATELY after registering!", Type.Object({
    username: Type.String({ description: "Your username" }),
    password: Type.String({ description: "Your password (256-bit hex)" }),
    empire: Type.String({ description: "Your empire" }),
    player_id: Type.String({ description: "Your player ID" }),
  })),
  paramTool("update_todo", "Update your local TODO list to track goals and progress.", Type.Object({
    content: Type.String({ description: "Full TODO list content (replaces existing)" }),
  })),
  simpleTool("read_todo", "Read your current TODO list."),
  paramTool("status_log", "Log a status message visible to the human watching.", Type.Object({
    category: StringEnum(["mining", "travel", "combat", "trade", "chat", "info", "craft", "faction", "mission", "setup"], {
      description: "Message category",
    }),
    message: Type.String({ description: "Status message" }),
  })),
];

// ─── Local tool names ────────────────────────────────────────

const LOCAL_TOOLS = new Set(["save_credentials", "update_todo", "read_todo", "status_log"]);

// ─── Tool Executor ───────────────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  api: SpaceMoltAPI,
  session: SessionManager,
): Promise<string> {
  logTool(name, args);

  // Handle local tools
  if (LOCAL_TOOLS.has(name)) {
    return executeLocalTool(name, args, session);
  }

  // Execute API tool
  try {
    const resp = await api.execute(name, Object.keys(args).length > 0 ? args : undefined);

    if (resp.error) {
      return `Error: [${resp.error.code}] ${resp.error.message}`;
    }

    return truncateResult(formatToolResult(name, resp.result, resp.notifications));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error executing ${name}: ${msg}`;
  }
}

const MAX_RESULT_CHARS = 4000;

function truncateResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return text.slice(0, MAX_RESULT_CHARS) + "\n\n... (truncated, " + text.length + " chars total)";
}

function executeLocalTool(
  name: string,
  args: Record<string, unknown>,
  session: SessionManager,
): string {
  switch (name) {
    case "save_credentials": {
      const creds = {
        username: String(args.username),
        password: String(args.password),
        empire: String(args.empire),
        playerId: String(args.player_id),
      };
      session.saveCredentials(creds);
      log("setup", `Credentials saved for ${creds.username}`);
      return `Credentials saved successfully for ${creds.username}.`;
    }
    case "update_todo": {
      session.saveTodo(String(args.content));
      log("info", "TODO list updated");
      return "TODO list updated.";
    }
    case "read_todo": {
      const todo = session.loadTodo();
      return todo || "(empty TODO list)";
    }
    case "status_log": {
      log(String(args.category), String(args.message));
      return "Logged.";
    }
    default:
      return `Unknown local tool: ${name}`;
  }
}
