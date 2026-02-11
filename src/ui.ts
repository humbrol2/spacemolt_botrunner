const COLORS: Record<string, string> = {
  setup: "\x1b[34m",    // blue
  mining: "\x1b[32m",   // green
  travel: "\x1b[36m",   // cyan
  combat: "\x1b[31m",   // red
  trade: "\x1b[33m",    // yellow
  chat: "\x1b[35m",     // magenta
  error: "\x1b[91m",    // bright red
  wait: "\x1b[33m",     // yellow
  info: "\x1b[37m",     // white
  tool: "\x1b[90m",     // gray
  agent: "\x1b[96m",    // bright cyan
  system: "\x1b[34m",   // blue
  craft: "\x1b[32m",    // green
  faction: "\x1b[35m",  // magenta
  mission: "\x1b[36m",  // cyan
  broadcast: "\x1b[91m", // bright red (admin broadcasts)
  dm: "\x1b[95m",        // bright magenta (private messages)
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function log(category: string, message: string): void {
  const color = COLORS[category] || COLORS.info;
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`${DIM}${timestamp}${RESET} ${color}[${category}]${RESET} ${message}`);
}

export function logDebug(message: string): void {
  if (!debugEnabled) return;
  log("system", message);
}

export function logError(message: string): void {
  log("error", message);
}

export function logTool(name: string, args?: Record<string, unknown>, reason?: string): void {
  const color = COLORS.tool;
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  const argsStr = args ? ` ${formatArgs(args)}` : "";
  const toolPart = `${DIM}\x1b[37m${name}${argsStr}${RESET}`;
  if (reason) {
    console.log(`${DIM}${timestamp}${RESET} ${color}[tool]${RESET} ${reason} ${DIM}—${RESET} ${toolPart}`);
  } else {
    console.log(`${DIM}${timestamp}${RESET} ${color}[tool]${RESET} ${toolPart}`);
  }
}

export function logAgent(text: string): void {
  log("agent", text);
}

const REDACTED_KEYS = new Set(["password", "token", "secret", "api_key"]);

function formatArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (REDACTED_KEYS.has(key)) {
      parts.push(`${key}=XXX`);
      continue;
    }
    const str = typeof value === "string" ? value : JSON.stringify(value);
    const truncated = str.length > 60 ? str.slice(0, 57) + "..." : str;
    parts.push(`${key}=${truncated}`);
  }
  return parts.join(" ");
}

/**
 * Log chat and system notifications to stdout so the human watching can see them.
 * Called when we receive notifications from the API response.
 */
export function logNotifications(notifications: unknown[]): void {
  if (!notifications || notifications.length === 0) return;

  for (const n of notifications) {
    if (typeof n !== "object" || n === null) continue;
    const notif = n as Record<string, unknown>;
    const type = notif.type as string | undefined;
    const msgType = notif.msg_type as string | undefined;
    let data = notif.data as Record<string, unknown> | string | undefined;

    // The HTTP API stores json.RawMessage in Data — if it arrives as a string, parse it
    if (typeof data === "string") {
      try { data = JSON.parse(data) as Record<string, unknown>; } catch { /* leave as string */ }
    }

    if (msgType === "chat_message" && data && typeof data === "object") {
      const channel = data.channel as string || "?";
      const sender = data.sender as string || "Unknown";
      const content = data.content as string || "";

      if (sender === "[ADMIN]") {
        log("broadcast", `[BROADCAST] ${content}`);
      } else if (channel === "private") {
        log("dm", `[DM from ${sender}] ${content}`);
      } else {
        const tag = channel.toUpperCase();
        log("chat", `[${tag}] ${sender}: ${content}`);
      }
      continue;
    }

    // System/tip notifications (gameplay tips, system messages)
    if ((type === "system" || type === "tip") && data && typeof data === "object") {
      const message = data.message as string || JSON.stringify(data);
      log("broadcast", `[SYSTEM] ${message}`);
      continue;
    }

    // Combat notifications
    if (type === "combat" && data && typeof data === "object") {
      log("combat", `[COMBAT] ${data.message || JSON.stringify(data)}`);
      continue;
    }

    // Trade notifications
    if (type === "trade" && data && typeof data === "object") {
      log("trade", `[TRADE] ${data.message || JSON.stringify(data)}`);
      continue;
    }

    // Catch-all: log any other notification type so nothing is silently dropped
    logDebug(`[notif type=${type} msg_type=${msgType}] ${JSON.stringify(data)}`);
  }
}

export function formatNotifications(notifications: unknown[]): string {
  if (!notifications || notifications.length === 0) return "";
  const lines: string[] = [];
  for (const n of notifications) {
    if (typeof n === "string") {
      lines.push(`  > ${n}`);
    } else if (typeof n === "object" && n !== null) {
      const notif = n as Record<string, unknown>;
      const type = notif.type || "event";
      const msg = notif.message || notif.content || JSON.stringify(n);
      lines.push(`  > [${type}] ${msg}`);
    }
  }
  return lines.join("\n");
}

export function formatToolResult(name: string, result: unknown, notifications?: unknown[]): string {
  const parts: string[] = [];
  if (notifications && Array.isArray(notifications) && notifications.length > 0) {
    parts.push("Notifications:");
    parts.push(formatNotifications(notifications));
    parts.push("");
  }
  if (typeof result === "string") {
    parts.push(result);
  } else {
    parts.push(JSON.stringify(result, null, 2));
  }
  return parts.join("\n");
}
