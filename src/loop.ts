import { complete } from "@mariozechner/pi-ai";
import type { Model, Context, AssistantMessage, ToolCall, Message } from "@mariozechner/pi-ai";
import type { SpaceMoltAPI } from "./api.js";
import type { SessionManager } from "./session.js";
import { executeTool } from "./tools.js";
import { log, logAgent, logError } from "./ui.js";

const MAX_TOOL_ROUNDS = 30;
const MAX_CONTEXT_MESSAGES = 200;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 5000;
const LLM_TIMEOUT_MS = 120_000; // 2 min timeout per LLM call

export interface LoopOptions {
  signal?: AbortSignal;
  apiKey?: string;
}

export async function runAgentTurn(
  model: Model<any>,
  context: Context,
  api: SpaceMoltAPI,
  session: SessionManager,
  options?: LoopOptions,
): Promise<void> {
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    if (options?.signal?.aborted) {
      log("system", "Turn aborted");
      return;
    }

    // Trim context if too long
    trimContext(context);

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
      // No tool calls — turn is done
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

async function completeWithRetry(
  model: Model<any>,
  context: Context,
  options?: LoopOptions,
): Promise<AssistantMessage> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      log("system", `Calling LLM (attempt ${attempt + 1}/${MAX_RETRIES}, ${context.messages.length} messages)...`);

      // Create a timeout abort if the caller didn't provide one
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(), LLM_TIMEOUT_MS);

      // Combine caller's signal with our timeout
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

        // Detect empty/error responses that might indicate connection issues
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

function trimContext(context: Context): void {
  if (context.messages.length <= MAX_CONTEXT_MESSAGES) return;

  // Keep the first user message (instruction) and trim the oldest messages after it
  const excess = context.messages.length - MAX_CONTEXT_MESSAGES;
  // Remove from index 1 (after first message) to preserve initial instruction
  context.messages.splice(1, excess);
  log("system", `Trimmed ${excess} old messages from context`);
}

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
