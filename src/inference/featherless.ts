import type { AgentProfile } from "../config.js";
import { FEATHERLESS_API_KEY, FEATHERLESS_BASE_URL, FEATHERLESS_USER_AGENT } from "./featherless-config.js";

const BASE_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": FEATHERLESS_USER_AGENT,
};

/** Carries the HTTP status so callers can distinguish "this model is unavailable, try another" from other failures — see docs/featherless-notes.md's error code table. */
export class FeatherlessError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "FeatherlessError";
    this.status = status;
  }
}

// Per docs/featherless-notes.md: 400 (model cold, not loaded), 403 (gated), 503 (overloaded) all
// mean "this specific model isn't usable right now," not "the request itself is broken" — worth
// trying a fallback model for these. 401 (bad key) and other errors are not model-specific, so
// retrying with a different model wouldn't help; those still fail immediately.
// 404 ("model_not_found") isn't in the docs' error table but was hit live during testing (a typo'd
// or delisted model id) — unambiguously "this model id doesn't work," so it belongs here too.
const MODEL_UNAVAILABLE_STATUS_CODES = new Set([400, 403, 404, 503]);

/**
 * Ranked-choice model fallback (loremaster.md's Provider Abstraction section): tries
 * profile.model first, then each of profile.fallbackModels in order, but only when the
 * failure looks like "this model isn't available" — anything else (bad API key, empty
 * reply, a real bug) fails immediately rather than silently retrying on a different model.
 */
export async function withModelFallback<T>(
  profile: AgentProfile,
  attempt: (profile: AgentProfile) => Promise<T>
): Promise<T> {
  const candidates = [profile.model, ...(profile.fallbackModels ?? [])];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i++) {
    try {
      return await attempt({ ...profile, model: candidates[i] });
    } catch (err) {
      lastError = err;
      const isLast = i === candidates.length - 1;
      if (isLast || !(err instanceof FeatherlessError) || !MODEL_UNAVAILABLE_STATUS_CODES.has(err.status)) {
        throw err;
      }
      // else: fall through to the next candidate
    }
  }
  throw lastError;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  /** Present on an assistant message that chose to call tools instead of (or alongside) replying with text. */
  toolCalls?: ToolCall[];
  /** Present on a "tool" role message — the result of one call from toolCalls, threaded back for the model's next turn. */
  toolCallId?: string;
}

export interface StreamHandlers {
  onToken: (text: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** Aborts if no chunk (including the initial response) arrives within this window. Resets on every chunk, so long-but-active generations aren't cut off. */
  idleTimeoutMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

/**
 * A hung or abandoned Featherless request must not be able to hold a
 * concurrency slot forever — with only 4 slots total, a couple of stuck
 * requests deadlocks the entire queue (this happened in testing: 4 stuck
 * compress jobs blocked every future prose reply). Every inference call
 * must have a hard ceiling.
 */
function armTimeout(timeoutMs: number, externalSignal?: AbortSignal): { signal: AbortSignal; reset: () => void; cleanup: () => void } {
  const controller = new AbortController();
  let timer: NodeJS.Timeout;

  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`no response for ${timeoutMs}ms`)), timeoutMs);
  };

  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", onExternalAbort);
  reset();

  return {
    signal: controller.signal,
    reset,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

export async function streamInference(
  profile: AgentProfile,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  options?: StreamOptions
): Promise<void> {
  if (!FEATHERLESS_API_KEY) {
    handlers.onError(new Error("FEATHERLESS_API_KEY is not set"));
    return;
  }

  const timeout = armTimeout(options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, options?.signal);

  let response: Response;
  try {
    response = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        ...BASE_HEADERS,
        Authorization: `Bearer ${FEATHERLESS_API_KEY}`,
      },
      body: JSON.stringify({
        model: profile.model,
        messages,
        temperature: profile.temperature,
        max_tokens: profile.responseLimit,
        stream: true,
      }),
      signal: timeout.signal,
    });
  } catch (err) {
    timeout.cleanup();
    handlers.onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (!response.ok || !response.body) {
    const bodyText = await safeText(response);
    timeout.cleanup();
    handlers.onError(new FeatherlessError(response.status, `Featherless request failed: ${response.status} ${bodyText}`));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      timeout.reset();
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          handlers.onDone();
          return;
        }
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) handlers.onToken(delta);
        } catch {
          // ignore malformed SSE chunk
        }
      }
    }
    handlers.onDone();
  } catch (err) {
    handlers.onError(err instanceof Error ? err : new Error(String(err)));
  } finally {
    timeout.cleanup();
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content ?? "" };
  }
  return { role: m.role, content: m.content };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Forces the model to call a specific tool rather than free-texting a reply.
 * For structured background tasks (compression, extraction, etc.) this is
 * the actual fix for models ignoring a plain-text instruction — the model
 * has to emit arguments matching the schema, not prose. Non-streaming: these
 * calls are backend-only, nothing needs to watch tokens arrive live.
 */
export async function callWithForcedTool(
  profile: AgentProfile,
  messages: ChatMessage[],
  tool: ToolDefinition,
  timeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  if (!FEATHERLESS_API_KEY) {
    throw new Error("FEATHERLESS_API_KEY is not set");
  }

  const timeout = armTimeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        ...BASE_HEADERS,
        Authorization: `Bearer ${FEATHERLESS_API_KEY}`,
      },
      body: JSON.stringify({
        model: profile.model,
        messages,
        temperature: profile.temperature,
        max_tokens: profile.responseLimit,
        stream: false,
        tools: [{ type: "function", function: tool }],
        tool_choice: { type: "function", function: { name: tool.name } },
      }),
      signal: timeout.signal,
    });
  } finally {
    timeout.cleanup();
  }

  if (!response.ok) {
    throw new FeatherlessError(response.status, `Featherless request failed: ${response.status} ${await safeText(response)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
  };
  const rawArgs = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!rawArgs) {
    throw new Error("model did not call the required tool");
  }

  try {
    return JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    throw new Error("model's tool call arguments were not valid JSON");
  }
}

export interface ToolCallTurnResult {
  content: string | null;
  toolCalls: ToolCall[];
}

/**
 * Lets the model choose whether to reply with text or call one or more
 * tools ("auto", not forced) — the Editor's setup conversation needs this:
 * the backend can't know in advance when the user has said enough to
 * justify creating a worldbook entry, so the model itself decides mid-turn
 * (loremaster.md's Tool Use section). Returns a single turn's result; the
 * caller is responsible for looping (append the assistant's tool_calls
 * message plus a "tool" result message per call, then call again) until a
 * plain-text reply comes back.
 */
export async function callWithTools(
  profile: AgentProfile,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  timeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS
): Promise<ToolCallTurnResult> {
  if (!FEATHERLESS_API_KEY) {
    throw new Error("FEATHERLESS_API_KEY is not set");
  }

  const timeout = armTimeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        ...BASE_HEADERS,
        Authorization: `Bearer ${FEATHERLESS_API_KEY}`,
      },
      body: JSON.stringify({
        model: profile.model,
        messages: messages.map(toWireMessage),
        temperature: profile.temperature,
        max_tokens: profile.responseLimit,
        stream: false,
        tools: tools.map((t) => ({ type: "function", function: t })),
        tool_choice: "auto",
      }),
      signal: timeout.signal,
    });
  } finally {
    timeout.cleanup();
  }

  if (!response.ok) {
    throw new FeatherlessError(response.status, `Featherless request failed: ${response.status} ${await safeText(response)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id?: string | null; function?: { name?: string; arguments?: string } }>;
      };
    }>;
  };
  const message = data.choices?.[0]?.message;
  // Featherless has been observed to return a null id on some of the entries when a model
  // calls several tools in one turn — a real id is required to thread each tool result back
  // to the right call on the next request, so a missing one gets a synthetic fallback rather
  // than being passed through (the API rejects a null id in the request that echoes it back).
  const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((tc, index) => {
    let args: Record<string, unknown> = {};
    try {
      args = tc.function?.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
    } catch {
      // Left empty — the tool executor validates required fields and reports back to the model as a tool error.
    }
    return { id: tc.id ?? `call_${index}_${Date.now()}`, name: tc.function?.name ?? "", arguments: args };
  });

  return { content: message?.content ?? null, toolCalls };
}
