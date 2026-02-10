import { complete } from "@mariozechner/pi-ai";
import type { Model, Context, AssistantMessage, ToolCall, Message } from "@mariozechner/pi-ai";
import type { SpaceMoltAPI } from "./api.js";
import type { SessionManager } from "./session.js";
import { executeTool } from "./tools.js";
import { log, logAgent, logError } from "./ui.js";

const MAX_TOOL_ROUNDS = 30;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 5000;
const LLM_TIMEOUT_MS = 120_000;

// ─── Context management constants ────────────────────────────

const CHARS_PER_TOKEN = 4;
const CONTEXT_BUDGET_RATIO = 0.55; // use 55% of context window for messages (rest: system prompt, tools, response)
const MIN_RECENT_MESSAGES = 10; // never compact below this many recent messages
const SUMMARY_MAX_TOKENS = 1024;

// ─── Public interface ────────────────────────────────────────

export interface LoopOptions {
  signal?: AbortSignal;
  apiKey?: string;
}

/** Accumulated summary of compacted messages, carried across turns. */
export interface CompactionState {
  summary: string;
}

export async function runAgentTurn(
  model: Model<any>,
  context: Context,
  api: SpaceMoltAPI,
  session: SessionManager,
  options?: LoopOptions,
  compaction?: CompactionState,
): Promise<void> {
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    if (options?.signal?.aborted) {
      log("system", "Turn aborted");
      return;
    }

    // Compact context if approaching token budget
    await compactContext(model, context, compaction, options);

    // Call the LLM
    let response: AssistantMessage;
    try {
      response = await completeWithRetry(model, context, options);
    } catch (err) {
      logError(`LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Add assistant message to context
    context.messages.push(response);

    // Log any text output
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        logAgent(block.text.trim());
      }
    }

    // Extract tool calls
    const toolCalls = response.content.filter((c): c is ToolCall => c.type === "toolCall");

    if (toolCalls.length === 0) {
      return;
    }

    // Execute each tool call
    for (const toolCall of toolCalls) {
      if (options?.signal?.aborted) {
        log("system", "Turn aborted during tool execution");
        return;
      }

      const result = await executeTool(toolCall.name, toolCall.arguments, api, session);

      const toolResultMessage: Message = {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: result }],
        isError: result.startsWith("Error"),
        timestamp: Date.now(),
      };

      context.messages.push(toolResultMessage);
    }

    rounds++;
  }

  log("wait", `Reached max tool rounds (${MAX_TOOL_ROUNDS}), ending turn`);
}

// ─── Context compaction ──────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateMessageTokens(msg: Message): number {
  if (typeof msg.content === "string") {
    return estimateTokens(msg.content);
  }
  if (Array.isArray(msg.content)) {
    let total = 0;
    for (const block of msg.content) {
      if ("text" in block) total += estimateTokens(block.text);
      else if ("name" in block) total += estimateTokens(block.name + JSON.stringify(block.arguments));
      else if ("thinking" in block) total += estimateTokens(block.thinking);
    }
    return total;
  }
  return 0;
}

function totalMessageTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) total += estimateMessageTokens(msg);
  return total;
}

/**
 * Find the nearest "turn boundary" at or after `idx`.
 * A turn boundary is a position where a user message starts —
 * i.e. we never split in the middle of an assistant + toolResult group.
 */
function findTurnBoundary(messages: Message[], idx: number): number {
  for (let i = idx; i < messages.length; i++) {
    if (messages[i].role === "user") return i;
  }
  // If no user message found after idx, try before
  for (let i = idx - 1; i >= 1; i--) {
    if (messages[i].role === "user") return i;
  }
  return idx;
}

/**
 * Format old messages into a readable block for the summarizer.
 */
function formatMessagesForSummary(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : "(complex)";
      lines.push(`[USER] ${text}`);
    } else if (msg.role === "assistant") {
      for (const block of msg.content) {
        if ("text" in block && block.text?.trim()) {
          lines.push(`[AGENT] ${block.text.trim()}`);
        } else if ("name" in block) {
          const args = Object.entries(block.arguments || {})
            .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join(", ");
          lines.push(`[TOOL CALL] ${block.name}(${args})`);
        }
      }
    } else if (msg.role === "toolResult") {
      const text = Array.isArray(msg.content)
        ? msg.content.map((b: any) => b.text || "").join("")
        : "";
      // Trim long results for the summary input
      const trimmed = text.length > 500 ? text.slice(0, 500) + "..." : text;
      const errorTag = msg.isError ? " [ERROR]" : "";
      lines.push(`[RESULT${errorTag}] ${msg.toolName}: ${trimmed}`);
    }
  }
  return lines.join("\n");
}

async function compactContext(
  model: Model<any>,
  context: Context,
  compaction?: CompactionState,
  options?: LoopOptions,
): Promise<void> {
  const budget = Math.floor(model.contextWindow * CONTEXT_BUDGET_RATIO);
  const currentTokens = totalMessageTokens(context.messages);

  if (currentTokens < budget) return;

  log("system", `Context at ~${currentTokens} tokens (budget: ${budget}). Compacting...`);

  // Determine split: keep ~60% of budget as recent messages
  const recentBudget = Math.floor(budget * 0.6);
  let recentTokens = 0;
  let splitIdx = context.messages.length;

  for (let i = context.messages.length - 1; i >= 1; i--) {
    const msgTokens = estimateMessageTokens(context.messages[i]);
    if (recentTokens + msgTokens > recentBudget && splitIdx < context.messages.length - MIN_RECENT_MESSAGES) {
      break;
    }
    recentTokens += msgTokens;
    splitIdx = i;
  }

  // Snap to a clean turn boundary
  splitIdx = findTurnBoundary(context.messages, splitIdx);

  if (splitIdx <= 1) {
    log("system", "Nothing to compact (all messages are recent)");
    return;
  }

  const oldMessages = context.messages.slice(1, splitIdx); // skip msg[0] (initial instruction)
  const recentMessages = context.messages.slice(splitIdx);

  // Try LLM summarization
  let summary: string;
  try {
    summary = await summarizeViaLLM(model, oldMessages, compaction?.summary, options);
    log("system", `Summarized ${oldMessages.length} messages into ~${estimateTokens(summary)} tokens`);
  } catch (err) {
    logError(`Summarization failed: ${err instanceof Error ? err.message : String(err)}`);
    // Fallback: keep the previous summary + a note about lost context
    summary = compaction?.summary
      ? compaction.summary + "\n\n(Additional context was lost due to summarization failure. Check captain's log.)"
      : "(Earlier session context was lost. Check your captain's log for history.)";
  }

  if (compaction) compaction.summary = summary;

  // Rebuild: [initial instruction] [summary message] [recent messages]
  const summaryMessage: Message = {
    role: "user" as const,
    content: `## Session History Summary\n\nThe following is a summary of your earlier actions this session. Use it to maintain continuity.\n\n${summary}\n\n---\nNow continue your mission. Recent events follow.`,
    timestamp: Date.now(),
  };

  context.messages = [context.messages[0], summaryMessage, ...recentMessages];
  log("system", `Compacted: ${oldMessages.length} old messages → summary + ${recentMessages.length} recent messages`);
}

async function summarizeViaLLM(
  model: Model<any>,
  oldMessages: Message[],
  previousSummary: string | undefined,
  options?: LoopOptions,
): Promise<string> {
  const transcript = formatMessagesForSummary(oldMessages);

  let prompt = "Summarize this game session transcript. ";
  prompt += "Focus on: current location, credits, ship status, cargo, active goals, key events, relationships with other players, and any important discoveries. ";
  prompt += "Be concise — bullet points are fine. Preserve all decision-relevant details.\n\n";

  if (previousSummary) {
    prompt += "Previous summary (from even earlier):\n" + previousSummary + "\n\n";
  }

  prompt += "Transcript to summarize:\n" + transcript;

  const summaryCtx: Context = {
    systemPrompt: "You are a concise summarizer. Output only the summary, no preamble.",
    messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }],
  };

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), 30_000);
  const signal = options?.signal
    ? combineAbortSignals(options.signal, timeoutController.signal)
    : timeoutController.signal;

  try {
    const resp = await complete(model, summaryCtx, {
      signal,
      apiKey: options?.apiKey,
      maxTokens: SUMMARY_MAX_TOKENS,
    });
    clearTimeout(timeout);

    const text = resp.content
      .filter((b): b is { type: "text"; text: string } => "text" in b)
      .map((b) => b.text)
      .join("");

    if (!text.trim()) throw new Error("Empty summary response");
    return text.trim();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ─── LLM call with retry ────────────────────────────────────

async function completeWithRetry(
  model: Model<any>,
  context: Context,
  options?: LoopOptions,
): Promise<AssistantMessage> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      log("system", `Calling LLM (attempt ${attempt + 1}/${MAX_RETRIES}, ${context.messages.length} messages)...`);

      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(), LLM_TIMEOUT_MS);

      const signal = options?.signal
        ? combineAbortSignals(options.signal, timeoutController.signal)
        : timeoutController.signal;

      try {
        const result = await complete(model, context, {
          signal,
          apiKey: options?.apiKey,
          maxTokens: 4096,
        });
        clearTimeout(timeout);

        if (result.stopReason === "error") {
          throw new Error(result.errorMessage || "LLM returned an error response");
        }
        if (result.content.length === 0) {
          throw new Error("LLM returned empty response — is the model loaded? Check: ollama ps");
        }

        log("system", `LLM responded: ${result.content.length} blocks, stop=${result.stopReason}, tokens=${result.usage?.totalTokens ?? "?"}`);
        return result;
      } catch (err) {
        clearTimeout(timeout);
        if (timeoutController.signal.aborted && !options?.signal?.aborted) {
          throw new Error(`LLM call timed out after ${LLM_TIMEOUT_MS / 1000}s — is the model loaded? (try: ollama run <model>)`);
        }
        throw err;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (options?.signal?.aborted) throw lastError;

      const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
      logError(`LLM error (attempt ${attempt + 1}/${MAX_RETRIES}): ${lastError.message}`);
      log("wait", `Retrying in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }

  throw lastError || new Error("LLM call failed after retries");
}

// ─── Utilities ───────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
