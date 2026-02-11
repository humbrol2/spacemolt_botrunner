import { Type, StringEnum } from "@mariozechner/pi-ai";
import type { Tool } from "@mariozechner/pi-ai";
import type { SpaceMoltAPI } from "./api.js";
import type { SessionManager } from "./session.js";
import { log, logTool, logDebug, formatToolResult, logNotifications } from "./ui.js";

// ─── Local Tool Definitions ─────────────────────────────────

export const localTools: Tool[] = [
  {
    name: "save_credentials",
    description: "Save your login credentials locally. Do this IMMEDIATELY after registering!",
    parameters: Type.Object({
      username: Type.String({ description: "Your username" }),
      password: Type.String({ description: "Your password (256-bit hex)" }),
      empire: Type.String({ description: "Your empire" }),
      player_id: Type.String({ description: "Your player ID" }),
    }),
  },
  {
    name: "update_todo",
    description: "Update your local TODO list to track goals and progress.",
    parameters: Type.Object({
      content: Type.String({ description: "Full TODO list content (replaces existing)" }),
    }),
  },
  {
    name: "read_todo",
    description: "Read your current TODO list.",
    parameters: Type.Object({}),
  },
  {
    name: "status_log",
    description: "Log a status message visible to the human watching.",
    parameters: Type.Object({
      category: StringEnum(["mining", "travel", "combat", "trade", "chat", "info", "craft", "faction", "mission", "setup"], {
        description: "Message category",
      }),
      message: Type.String({ description: "Status message" }),
    }),
  },
];

// ─── Local tool names ────────────────────────────────────────

const LOCAL_TOOLS = new Set(["save_credentials", "update_todo", "read_todo", "status_log"]);

// ─── Tool Executor ───────────────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  api: SpaceMoltAPI,
  session: SessionManager,
  reason?: string,
): Promise<string> {
  logTool(name, args, reason);

  // Handle local tools
  if (LOCAL_TOOLS.has(name)) {
    return executeLocalTool(name, args, session);
  }

  // Execute API tool
  try {
    const resp = await api.execute(name, Object.keys(args).length > 0 ? args : undefined);

    // Log chat/system notifications to stdout for the human watching
    if (resp.notifications && Array.isArray(resp.notifications) && resp.notifications.length > 0) {
      logDebug(`Received ${resp.notifications.length} notification(s)`);
      logNotifications(resp.notifications);
    }

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
