/**
 * Provider dispatch — Featherless streaming with model fallback.
 *
 * Extracted from dispatch.ts so the streaming/fallback logic is testable
 * independently of the scan loop. Horde submit/poll stays in dispatch for now
 * (it has tighter coupling to the scan loop via maybeQueue* helpers).
 */
import type { AgentProfile } from '../config.js'
import {
  streamInference,
  withModelFallback,
  FeatherlessError,
  JobCancelledError,
  shouldPrefillReasoning,
  resolveChatTemplateKwargs,
  REASONING_ASSISTANT_PREFILL,
  streamIdleTimeoutMs,
  type ChatMessage,
} from '../inference/featherless.js'
import { ReasoningStreamSplitter } from '../inference/reasoning-stream.js'
import { publishToken, publishThinking, publishStreamReset } from './job-events.js'
import { streamingModels } from './cancel.js'

const EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE = 2

/**
 * Streams a reply with model fallback, treating an empty-but-error-free completion as a
 * retriable failure rather than a valid (if useless) result. Providers sometimes signal
 * overload by closing the stream immediately with zero content chunks instead of a clean
 * HTTP error (observed live with Kimi-K2-Instruct returning a 503 on a plain non-streaming
 * call, moments after a streaming call to the same model produced zero tokens with no
 * error) — without this, that failure mode would silently bypass withModelFallback
 * entirely, since the emptiness was only ever checked after it had already returned.
 *
 * Reasoning routing is shape-based, not model-name-based (docs/providers/model-shape-probe-2026-07-17.md):
 * whatever arrives via `reasoning`/`reasoning_content` (a separate delta field) or a `<think>` tag
 * inline in `content` (parsed by ReasoningStreamSplitter — Qwen3 uses this shape, DeepSeek/Kimi/gpt-oss
 * use the separate-field shape) always goes to the thinking-trace channel, unconditionally, for any
 * model. There's no attempt to guess whether reasoning-field text is secretly a misrouted answer
 * (an earlier version of this code tried, screening for a DeepSeek-specific leaked-artifact string —
 * that never generalized past DeepSeek and silently failed on every other family, which is exactly
 * what surfaced this bug on Kimi-K2.7-Code). If a candidate produces reasoning but the answer
 * channel (`content`) never gets anything, that's treated the same as a genuinely empty completion —
 * a retriable failure — rather than promoting the reasoning text into the reply, since a model can
 * legitimately exhaust its token budget mid-thought (confirmed live on Kimi-K2-Thinking) and showing
 * raw chain-of-thought as if it were the story would be worse than retrying.
 *
 * Separately, `resolveChatTemplateKwargs` defaults `enable_thinking`/`thinking` to `false` below
 * unless the caller explicitly overrides it — needed because at least one family (GLM-4.7-Flash)
 * reasons as plain, unmarked text glued directly into `content` with no field or tag at all when
 * no chat_template_kwargs are sent, which no amount of shape-based routing can separate out after
 * the fact.
 *
 * For a reasoning model specifically, an empty-completion failure has a known, reproducible cause
 * on top of the above: its chat template lets the model decide, per turn, whether/how to open its
 * own `<think>` block, and under temperature the very first sampled token can land on an immediate
 * close-and-stop instead — confirmed live by replaying an identical failing request repeatedly.
 * Prefilling the assistant turn with an already-open block (see REASONING_ASSISTANT_PREFILL)
 * removes that coin-flip — but only when thinking is enabled; Effort Off sets enable_thinking:
 * false and skips prefill entirely (see shouldPrefillReasoning). EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE
 * retries before handing off to the next fallback candidate (if any).
 */
export async function streamWithFallback(
  profile: AgentProfile,
  apiKey: string,
  messages: ChatMessage[],
  jobId: string,
  signal?: AbortSignal,
  chatTemplateKwargs?: Record<string, unknown>,
  prefillAssistant = false,
): Promise<{ text: string; model: string }> {
  const effectiveKwargs = resolveChatTemplateKwargs(chatTemplateKwargs)
  let reply = ''
  let usedModel = profile.model
  let isFirstStream = true
  await withModelFallback(profile, async (candidate) => {
    usedModel = candidate.model
    streamingModels.set(jobId, candidate.model)
    const usePrefill = prefillAssistant || shouldPrefillReasoning(candidate.model, effectiveKwargs)
    const candidateMessages = usePrefill
      ? [...messages, { role: 'assistant' as const, content: REASONING_ASSISTANT_PREFILL }]
      : messages

    for (let attempt = 1; attempt <= EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE; attempt++) {
      if (!isFirstStream) {
        publishStreamReset(jobId, { thinking: true, text: true }, `Retrying… (attempt ${attempt})`)
      }
      isFirstStream = false

      const splitter = new ReasoningStreamSplitter({ startsInThinking: false })
      reply = ''
      let sawReasoning = false
      const emitThinking = (text: string) => {
        sawReasoning = true
        publishThinking(jobId, text)
      }
      const emitAnswer = (text: string) => {
        reply += text
        publishToken(jobId, text)
      }
      try {
        await new Promise<void>((resolve, reject) => {
          void streamInference(
            candidate,
            apiKey,
            candidateMessages,
            {
              onToken: (text) => {
                splitter.push(text, emitThinking, emitAnswer)
              },
              onReasoningToken: emitThinking,
              onDone: () => {
                splitter.flush(emitThinking, emitAnswer)
                if (reply.trim()) {
                  resolve()
                } else if (sawReasoning) {
                  reject(
                    new FeatherlessError(
                      503,
                      `${candidate.model} returned reasoning but no answer content`,
                    ),
                  )
                } else {
                  reject(
                    new FeatherlessError(503, `${candidate.model} returned an empty completion`),
                  )
                }
              },
              onError: reject,
            },
            {
              signal,
              chatTemplateKwargs: effectiveKwargs,
              idleTimeoutMs: streamIdleTimeoutMs(candidate.model, effectiveKwargs),
            },
          )
        })
        return
      } catch (err) {
        if (err instanceof JobCancelledError) throw err
        const isEmptyCompletion =
          err instanceof FeatherlessError &&
          (err.message.includes('empty completion') || err.message.includes('no answer content'))
        if (!isEmptyCompletion || attempt === EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE) throw err
      }
    }
  })
  return { text: reply, model: usedModel }
}
