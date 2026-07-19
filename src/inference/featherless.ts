import type { AgentProfile, ModelParams } from '../config.js'
import { FEATHERLESS_BASE_URL, FEATHERLESS_USER_AGENT } from './featherless-config.js'
import { getGlobalDb } from '../db/global-db.js'
import { recordModelOutcome } from '../db/model-config-store.js'
import { logOutboundRequest, logOutboundResponse } from './outbound-telemetry.js'
import { formatError } from '../lib/errors.js'
import { stripThinkingTags } from './reasoning-stream.js'

/** Optional sampler params (Config > Agents), omitted entirely rather than sent as null/0 when unset — see docs' completions parameter list. */
function samplerParams(profile: AgentProfile): Record<string, number> {
  const params: Record<string, number> = {}
  if (profile.presencePenalty !== undefined) params.presence_penalty = profile.presencePenalty
  if (profile.frequencyPenalty !== undefined) params.frequency_penalty = profile.frequencyPenalty
  if (profile.repetitionPenalty !== undefined) params.repetition_penalty = profile.repetitionPenalty
  if (profile.topP !== undefined) params.top_p = profile.topP
  if (profile.topK !== undefined) params.top_k = profile.topK
  if (profile.minP !== undefined) params.min_p = profile.minP
  return params
}

// Same rough chars/4 estimate used throughout the codebase (see history.ts) — not a real
// tokenizer. Good enough for Config > Agents' per-model token-sum telemetry.
const CHARS_PER_TOKEN_ESTIMATE = 4
function tokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE)
}
function estimateTokens(text: string): number {
  return tokensFromChars(text.length)
}
export function estimateMessageTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0)
}

/** Best-effort — a stats-write failure must never break the actual inference call it's reporting on. */
function recordOutcome(
  profile: AgentProfile,
  outcome: { success: boolean; inputTokens: number; outputTokens: number },
): void {
  if (!profile.configId) return
  try {
    recordModelOutcome(getGlobalDb(), profile.configId, outcome)
  } catch {
    // ignore
  }
}

const BASE_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': FEATHERLESS_USER_AGENT,
}

/** Carries the HTTP status so callers can distinguish "this model is unavailable, try another" from other failures — see docs/featherless-notes.md's error code table. */
export class FeatherlessError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'FeatherlessError'
    this.status = status
  }
}

/** Thrown when an in-flight call is aborted because the user cancelled the job — distinct from an idle-timeout or network failure so callers can skip model-fallback and mark the job cancelled rather than failed. */
export class JobCancelledError extends Error {
  constructor(message = 'cancelled by user') {
    super(message)
    this.name = 'JobCancelledError'
  }
}

// Per docs/featherless-notes.md: 400 (model cold, not loaded), 403 (gated), 503 (overloaded) all
// mean "this specific model isn't usable right now," not "the request itself is broken" — worth
// trying a fallback model for these. 401 (bad key) and other errors are not model-specific, so
// retrying with a different model wouldn't help; those still fail immediately.
// 404 ("model_not_found") isn't in the docs' error table but was hit live during testing (a typo'd
// or delisted model id) — unambiguously "this model id doesn't work," so it belongs here too.
const MODEL_UNAVAILABLE_STATUS_CODES = new Set([400, 403, 404, 503])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const TRANSIENT_RETRY_DELAYS_MS = [5000, 15000]

/** Same-model backoff for Featherless 500/503 before cross-model fallback kicks in. */
export async function withTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (!(err instanceof FeatherlessError) || (err.status !== 500 && err.status !== 503)) {
        throw err
      }
      if (attempt >= TRANSIENT_RETRY_DELAYS_MS.length) throw err
      await sleep(TRANSIENT_RETRY_DELAYS_MS[attempt]!)
    }
  }
  throw lastError
}

/**
 * A reasoning model's chat template leaves it up to the model, per turn, to decide whether/how
 * to open its own `<think>` block. Under higher temperature, the very first sampled token can
 * land on an immediate close-and-stop instead of opening reasoning at all — a genuinely empty
 * completion, confirmed live by replaying the exact same request repeatedly (same input, same
 * params, intermittent zero-token completions with finish_reason "stop"). Prefilling the
 * assistant turn with an already-open `<think>\n` block (see the trailing message pushed in
 * streamWithFallback) removes that coin-flip — the same "assistant prefill" technique
 * SillyTavern's own reasoning-model presets use.
 *
 * This is a pre-response heuristic only — used for the prefill trick above and for
 * `streamIdleTimeoutMs` below, both of which have to be decided before any reply exists, so they
 * can't be based on what actually comes back. It is deliberately NOT used to decide how to route
 * reasoning content once a reply arrives — see `docs/providers/model-shape-probe-2026-07-17.md`,
 * which found real models across several families (Kimi, gpt-oss) emit the same `delta.reasoning`
 * shape as DeepSeek despite not matching this name check, so `streamWithFallback`'s routing is
 * shape-based (does `reasoning`/`reasoning_content`/a `<think>` tag actually show up) instead.
 * Detected by model id substring since AgentProfile has no explicit reasoning-model flag yet;
 * expand this list as more reasoning families need the prefill trick specifically.
 */
export function isReasoningModel(model: string): boolean {
  return /deepseek/i.test(model)
}

/** Assistant-turn prefill that prevents empty first-token stops on reasoning-family models. */
export const REASONING_ASSISTANT_PREFILL = '<think>\n'

/**
 * Effort Off (`enable_thinking: false`) skips the prefill — confirmed live: prefill +
 * enable_thinking false routes IC prose through delta.reasoning only, which triggered false
 * "reasoning but no answer content" retries.
 */
export function shouldPrefillReasoning(
  model: string,
  chatTemplateKwargs?: Record<string, unknown>,
): boolean {
  if (chatTemplateKwargs?.enable_thinking === false) return false
  return isReasoningModel(model)
}

/**
 * Expands a caller's `chat_template_kwargs` into the full set Featherless's model families
 * actually read, rather than a single flat key. Per featherless.ai/docs/chat-template-kwargs,
 * Qwen/GLM/Gemma read `enable_thinking`; DeepSeek/Kimi read `thinking` instead — two different
 * keys for the same toggle. Sending both covers whichever one a given family honors without a
 * per-model registry; an unrecognized key is silently ignored (confirmed empirically in both
 * directions — GLM ignores `thinking`, and this codebase already relied on DeepSeek honoring
 * `enable_thinking` despite the docs saying it shouldn't — see
 * docs/providers/model-shape-probe-2026-07-17.md).
 *
 * Defaults to reasoning off unless the caller explicitly asked for it — GLM-4.7-Flash reasons as
 * unmarked plain text glued into `content` with no `chat_template_kwargs` sent at all, which no
 * amount of after-the-fact routing can separate back out (same doc).
 *
 * When thinking is explicitly on, also asks Featherless to retain reasoning across turns
 * (`preserve_thinking`/`clear_thinking`, again two keys for one idea depending on family) per the
 * docs' explicit guidance that agentic/multi-step tool use needs this — irrelevant, and omitted,
 * when thinking is off, since there's nothing to retain.
 */
export function resolveChatTemplateKwargs(
  chatTemplateKwargs?: Record<string, unknown>,
): Record<string, unknown> {
  const enableThinking = chatTemplateKwargs?.enable_thinking ?? false
  const resolved: Record<string, unknown> = {
    ...chatTemplateKwargs,
    enable_thinking: enableThinking,
    thinking: enableThinking,
  }
  if (enableThinking) {
    resolved.preserve_thinking = true
    resolved.clear_thinking = false
  }
  return resolved
}

/**
 * Ranked-choice model fallback (loremaster.md's Provider Abstraction section): tries
 * profile.model first, then each of profile.fallbackModels in order, but only when the
 * failure looks like "this model isn't available" — anything else (bad API key, empty
 * reply, a real bug) fails immediately rather than silently retrying on a different model.
 */
export async function withModelFallback<T>(
  profile: AgentProfile,
  attempt: (profile: AgentProfile) => Promise<T>,
): Promise<T> {
  // Build the candidate list: primary first, then fallbacks. When fallbackProfiles is
  // populated (getAgentProfile from model_configs), each candidate carries its own
  // temperature, sampler params, and configId — not just a model string. When absent
  // (hardcoded defaults, old agent_configs path), fall back to model/configId-only swapping.
  const primaryParams: ModelParams = {
    model: profile.model,
    temperature: profile.temperature,
    responseLimit: profile.responseLimit,
    contextLimit: profile.contextLimit,
    presencePenalty: profile.presencePenalty,
    frequencyPenalty: profile.frequencyPenalty,
    repetitionPenalty: profile.repetitionPenalty,
    topP: profile.topP,
    topK: profile.topK,
    minP: profile.minP,
    concurrencyCost: profile.concurrencyCost,
    configId: profile.configId,
  }
  const candidates: ModelParams[] = [
    primaryParams,
    ...(profile.fallbackProfiles ??
      profile.fallbackModels?.map((model, i) => ({
        ...primaryParams,
        model,
        configId: profile.fallbackConfigIds?.[i],
      })) ??
      []),
  ]
  let lastError: unknown

  for (let i = 0; i < candidates.length; i++) {
    try {
      return await withTransientRetry(() => attempt({ ...profile, ...candidates[i]! }))
    } catch (err) {
      lastError = err
      const isLast = i === candidates.length - 1
      if (
        isLast ||
        !(err instanceof FeatherlessError) ||
        !MODEL_UNAVAILABLE_STATUS_CODES.has(err.status)
      ) {
        throw err
      }
      // else: fall through to the next candidate
    }
  }
  throw lastError
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | null
  /** Present on an assistant message that chose to call tools instead of (or alongside) replying with text. */
  toolCalls?: ToolCall[]
  /** Present on a "tool" role message — the result of one call from toolCalls, threaded back for the model's next turn. */
  toolCallId?: string
}

export interface StreamHandlers {
  onToken: (text: string) => void
  /** Reasoning/thinking tokens — Featherless DeepSeek uses `delta.reasoning`; others may use `reasoning_content`. */
  onReasoningToken?: (text: string) => void
  onDone: () => void
  onError: (err: Error) => void
}

export interface StreamOptions {
  signal?: AbortSignal
  /** Aborts if no chunk (including the initial response) arrives within this window. Resets on every chunk, so long-but-active generations aren't cut off. */
  idleTimeoutMs?: number
  chatTemplateKwargs?: Record<string, unknown>
}

const DEFAULT_IDLE_TIMEOUT_MS = 90_000
/** Reasoning models may sit in a thinking phase with sparse or reasoning-only chunks. */
export const REASONING_IDLE_TIMEOUT_MS = 300_000

/** Pre-response only (see `isReasoningModel`'s comment) — budgets the idle timeout, doesn't gate trace routing. */
export function usesThinkingMode(
  model: string,
  chatTemplateKwargs?: Record<string, unknown>,
): boolean {
  if (chatTemplateKwargs?.enable_thinking === true) return true
  if (chatTemplateKwargs?.enable_thinking === false) return false
  return isReasoningModel(model)
}

export function streamIdleTimeoutMs(
  model: string,
  chatTemplateKwargs?: Record<string, unknown>,
): number {
  return usesThinkingMode(model, chatTemplateKwargs)
    ? REASONING_IDLE_TIMEOUT_MS
    : DEFAULT_IDLE_TIMEOUT_MS
}
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/**
 * A hung or abandoned Featherless request must not be able to hold a
 * concurrency slot forever — with only 4 slots total, a couple of stuck
 * requests deadlocks the entire queue (this happened in testing: 4 stuck
 * compress jobs blocked every future prose reply). Every inference call
 * must have a hard ceiling.
 */
function armTimeout(
  timeoutMs: number,
  externalSignal?: AbortSignal,
): { signal: AbortSignal; reset: () => void; cleanup: () => void } {
  const controller = new AbortController()
  let timer: NodeJS.Timeout

  const reset = () => {
    clearTimeout(timer)
    timer = setTimeout(
      () => controller.abort(new Error(`no response for ${timeoutMs}ms`)),
      timeoutMs,
    )
  }

  const onExternalAbort = () => controller.abort(externalSignal?.reason)
  externalSignal?.addEventListener('abort', onExternalAbort)
  reset()

  return {
    signal: controller.signal,
    reset,
    cleanup: () => {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    },
  }
}

export async function streamInference(
  profile: AgentProfile,
  apiKey: string,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  options?: StreamOptions,
): Promise<void> {
  if (!apiKey) {
    handlers.onError(new Error('No Featherless API key configured — set one in the Agents tab'))
    return
  }

  const inputTokens = estimateMessageTokens(messages)
  const startedAt = Date.now()
  let outputChars = 0
  const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS

  logOutboundRequest({ call: 'streamInference', model: profile.model, messages })
  const timeout = armTimeout(idleTimeoutMs, options?.signal)

  let response: Response
  try {
    response = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        ...BASE_HEADERS,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: profile.model,
        messages,
        temperature: profile.temperature,
        max_tokens: profile.responseLimit,
        stream: true,
        ...samplerParams(profile),
        ...(options?.chatTemplateKwargs
          ? { chat_template_kwargs: options.chatTemplateKwargs }
          : {}),
      }),
      signal: timeout.signal,
    })
  } catch (err) {
    timeout.cleanup()
    recordOutcome(profile, { success: false, inputTokens, outputTokens: 0 })
    handlers.onError(err instanceof Error ? err : new Error(String(err)))
    return
  }

  if (!response.ok || !response.body) {
    const bodyText = await safeText(response)
    timeout.cleanup()
    recordOutcome(profile, { success: false, inputTokens, outputTokens: 0 })
    handlers.onError(
      new FeatherlessError(
        response.status,
        `Featherless request failed: ${response.status} ${bodyText}`,
      ),
    )
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      timeout.reset()
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') {
          recordOutcome(profile, {
            success: true,
            inputTokens,
            outputTokens: tokensFromChars(outputChars),
          })
          handlers.onDone()
          return
        }
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string | null
                reasoning_content?: string | null
                reasoning?: string | null
              }
            }>
          }
          const delta = parsed.choices?.[0]?.delta
          const reasoning =
            delta?.reasoning_content ??
            (typeof delta?.reasoning === 'string' ? delta.reasoning : null)
          if (reasoning) {
            outputChars += reasoning.length
            handlers.onReasoningToken?.(reasoning)
          }
          const content = delta?.content
          if (content) {
            outputChars += content.length
            handlers.onToken(content)
          }
        } catch {
          // ignore malformed SSE chunk
        }
      }
    }
    const latency = Date.now() - startedAt
    const outTok = tokensFromChars(outputChars)
    logOutboundResponse('streamInference', profile.model, {
      success: true,
      latencyMs: latency,
      inputTokens,
      outputTokens: outTok,
      retries: 0,
    })
    recordOutcome(profile, { success: true, inputTokens, outputTokens: outTok })
    handlers.onDone()
  } catch (err) {
    const latency = Date.now() - startedAt
    const outTok = tokensFromChars(outputChars)
    logOutboundResponse('streamInference', profile.model, {
      success: false,
      latencyMs: latency,
      inputTokens,
      outputTokens: outTok,
      retries: 0,
      error: formatError(err),
    })
    recordOutcome(profile, { success: false, inputTokens, outputTokens: outTok })
    if (err instanceof Error && err.name === 'AbortError') {
      handlers.onError(new Error(`stream idle timeout (${idleTimeoutMs}ms without provider data)`))
    } else {
      handlers.onError(err instanceof Error ? err : new Error(String(err)))
    }
  } finally {
    timeout.cleanup()
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    }
  }
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' }
  }
  return { role: m.role, content: m.content }
}

export interface CompletionWithMeta {
  content: string
  /** `choices[0].finish_reason` verbatim ("stop", "length", …) — null when the provider omits it. "length" is the ground-truth truncation signal; prefer it over any length heuristic. */
  finishReason: string | null
}

/**
 * A single plain non-streaming completion — no tools, no forced structure. For a short
 * background task whose output shape is enforced by a bracket-tag convention in the prompt
 * (see extractSummary in dispatch.ts) rather than by the API's tool-calling machinery,
 * so the request itself stays as simple as streamInference's non-streaming twin.
 *
 * Most callers only need the text — use completeChat. Callers that must detect a
 * max_tokens cutoff (fold digests) use this variant for the finish_reason.
 */
export async function completeChatWithMeta(
  profile: AgentProfile,
  apiKey: string,
  messages: ChatMessage[],
  options?: {
    timeoutMs?: number
    signal?: AbortSignal
    chatTemplateKwargs?: Record<string, unknown>
    maxTokens?: number
  },
): Promise<CompletionWithMeta> {
  if (!apiKey) {
    throw new Error('No Featherless API key configured — set one in the Agents tab')
  }

  const inputTokens = estimateMessageTokens(messages)
  logOutboundRequest({ call: 'completeChat', model: profile.model, messages })
  const startedAt = Date.now()
  const timeout = armTimeout(options?.timeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS, options?.signal)
  // completeChat has no reasoning/answer split (no streaming, no ReasoningStreamSplitter) — a
  // model whose default is to reason inline in `content` with no field or tag (confirmed live on
  // GLM-4.7-Flash with no chat_template_kwargs sent, see docs/providers/model-shape-probe-2026-07-17.md)
  // would corrupt this call's result outright, since callers here (worldbook compact, story-to-date
  // summaries, scene/story naming) feed the raw string straight into stored data. Default reasoning
  // off unless a caller explicitly opts in; stripThinkingTags below covers the tag-in-content shape
  // (Qwen3) for any caller that does opt in.
  const chatTemplateKwargs = resolveChatTemplateKwargs(options?.chatTemplateKwargs)
  try {
    const response = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        ...BASE_HEADERS,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: profile.model,
        messages,
        temperature: profile.temperature,
        max_tokens: options?.maxTokens ?? profile.responseLimit,
        stream: false,
        ...samplerParams(profile),
        chat_template_kwargs: chatTemplateKwargs,
      }),
      signal: timeout.signal,
    })

    if (!response.ok) {
      const latency = Date.now() - startedAt
      const bodyText = await safeText(response)
      logOutboundResponse('completeChat', profile.model, {
        success: false,
        latencyMs: latency,
        inputTokens,
        outputTokens: 0,
        retries: 0,
        error: `HTTP ${response.status}: ${bodyText}`,
      })
      recordOutcome(profile, { success: false, inputTokens, outputTokens: 0 })
      throw new FeatherlessError(
        response.status,
        `Featherless request failed: ${response.status} ${bodyText}`,
      )
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>
    }
    const rawContent = data.choices?.[0]?.message?.content
    const finishReason = data.choices?.[0]?.finish_reason ?? null
    const content = rawContent ? stripThinkingTags(rawContent) : rawContent
    if (!content) {
      const latency = Date.now() - startedAt
      logOutboundResponse('completeChat', profile.model, {
        success: false,
        latencyMs: latency,
        inputTokens,
        outputTokens: 0,
        retries: 0,
        error: 'model returned empty completion',
      })
      recordOutcome(profile, { success: false, inputTokens, outputTokens: 0 })
      throw new Error('model returned an empty completion')
    }

    const latency = Date.now() - startedAt
    const outTok = estimateTokens(content)
    logOutboundResponse('completeChat', profile.model, {
      success: true,
      latencyMs: latency,
      inputTokens,
      outputTokens: outTok,
      retries: 0,
    })
    recordOutcome(profile, { success: true, inputTokens, outputTokens: outTok })
    return { content, finishReason }
  } finally {
    timeout.cleanup()
  }
}

/** completeChatWithMeta minus the metadata — the common case. */
export async function completeChat(
  profile: AgentProfile,
  apiKey: string,
  messages: ChatMessage[],
  options?: {
    timeoutMs?: number
    signal?: AbortSignal
    chatTemplateKwargs?: Record<string, unknown>
    maxTokens?: number
  },
): Promise<string> {
  return (await completeChatWithMeta(profile, apiKey, messages, options)).content
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCallTurnResult {
  content: string | null
  toolCalls: ToolCall[]
}

/**
 * Lets the model choose whether to reply with text or call one or more tools ("auto"), or —
 * when forceToolName is given — forces one specific tool the same way callWithForcedTool
 * does, but (unlike callWithForcedTool) returns full call metadata including the real tool
 * call id, so the caller can thread a forced call into a longer conversation (append the
 * assistant's tool_calls message plus a "tool" result message, then call again) the same way
 * auto-mode looping works. This exists because auto-mode with multiple simultaneous tool
 * calls in one response was unreliable in testing (garbled/missing function names) — looping
 * single *forced* calls keeps each individual call as simple as the pattern proven reliable
 * for compress/archive, while still letting the model decide how many times to loop.
 */
export async function callWithTools(
  profile: AgentProfile,
  apiKey: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  options?: {
    forceToolName?: string
    timeoutMs?: number
    chatTemplateKwargs?: Record<string, unknown>
  },
): Promise<ToolCallTurnResult> {
  if (!apiKey) {
    throw new Error('No Featherless API key configured — set one in the Agents tab')
  }

  const inputTokens = estimateMessageTokens(messages)
  logOutboundRequest({ call: 'callWithTools', model: profile.model, messages })
  const startedAt = Date.now()
  const timeout = armTimeout(options?.timeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS)
  // Same rationale as completeChat above: no reasoning/answer split here either, so an unmarked-
  // or tag-shaped reasoning model would otherwise corrupt `content` or a forced tool call's
  // arguments outright. Default off; stripThinkingTags below covers the tag-in-content shape.
  const chatTemplateKwargs = resolveChatTemplateKwargs(options?.chatTemplateKwargs)
  let response: Response
  try {
    response = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        ...BASE_HEADERS,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: profile.model,
        messages: messages.map(toWireMessage),
        temperature: profile.temperature,
        max_tokens: profile.responseLimit,
        stream: false,
        tools: tools.map((t) => ({ type: 'function', function: t })),
        tool_choice: options?.forceToolName
          ? { type: 'function', function: { name: options.forceToolName } }
          : 'auto',
        ...samplerParams(profile),
        chat_template_kwargs: chatTemplateKwargs,
      }),
      signal: timeout.signal,
    })
  } finally {
    timeout.cleanup()
  }

  if (!response.ok) {
    const latency = Date.now() - startedAt
    const bodyText = await safeText(response)
    logOutboundResponse('callWithTools', profile.model, {
      success: false,
      latencyMs: latency,
      inputTokens,
      outputTokens: 0,
      retries: 0,
      error: `HTTP ${response.status}: ${bodyText}`,
    })
    recordOutcome(profile, { success: false, inputTokens, outputTokens: 0 })
    throw new FeatherlessError(
      response.status,
      `Featherless request failed: ${response.status} ${bodyText}`,
    )
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null
        tool_calls?: Array<{ id?: string | null; function?: { name?: string; arguments?: string } }>
      }
    }>
  }
  const message = data.choices?.[0]?.message
  const content = message?.content ? stripThinkingTags(message.content) : (message?.content ?? null)
  // Featherless has been observed to return a null id on some of the entries when a model
  // calls several tools in one turn — a real id is required to thread each tool result back
  // to the right call on the next request, so a missing one gets a synthetic fallback rather
  // than being passed through (the API rejects a null id in the request that echoes it back).
  const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((tc, index) => {
    let args: Record<string, unknown> = {}
    try {
      args = tc.function?.arguments
        ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
        : {}
    } catch {
      // Left empty — the tool executor validates required fields and reports back to the model as a tool error.
    }
    return {
      id: tc.id ?? `call_${index}_${Date.now()}`,
      name: tc.function?.name ?? '',
      arguments: args,
    }
  })

  const outputChars =
    (content ?? '').length +
    toolCalls.reduce((sum, tc) => sum + JSON.stringify(tc.arguments).length, 0)
  const latency = Date.now() - startedAt
  const outTok = tokensFromChars(outputChars)
  logOutboundResponse('callWithTools', profile.model, {
    success: true,
    latencyMs: latency,
    inputTokens,
    outputTokens: outTok,
    retries: 0,
  })
  recordOutcome(profile, { success: true, inputTokens, outputTokens: outTok })
  return { content, toolCalls }
}
