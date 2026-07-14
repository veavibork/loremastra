/**
 * Provider dispatch — Featherless streaming with model fallback.
 *
 * Extracted from pipeline-runner.ts so the streaming/fallback logic is testable
 * independently of the scan loop. Horde submit/poll stays in pipeline-runner for now
 * (it has tighter coupling to the scan loop via maybeQueue* helpers).
 */
import type { AgentProfile } from '../config.js'
import {
  streamInference,
  withModelFallback,
  FeatherlessError,
  JobCancelledError,
  shouldPrefillReasoning,
  proseStreamUsesReasoningTrace,
  looksLikeLeakedReasoningArtifact,
  REASONING_ASSISTANT_PREFILL,
  streamIdleTimeoutMs,
  type ChatMessage,
} from '../inference/featherless.js'
import { ReasoningStreamSplitter } from '../inference/reasoning-stream.js'
import { publishToken, publishThinking, publishStreamReset } from './job-events.js'
import { streamingModels } from './cancel.js'

const EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE = 2

/** Chars to accumulate before testing looksLikeLeakedReasoningArtifact — comfortably more than "article". */
const REASONING_LEAK_PEEK_CHARS = 16

/**
 * Streams a reply with model fallback, treating an empty-but-error-free completion as a
 * retriable failure rather than a valid (if useless) result. Providers sometimes signal
 * overload by closing the stream immediately with zero content chunks instead of a clean
 * HTTP error (observed live with Kimi-K2-Instruct returning a 503 on a plain non-streaming
 * call, moments after a streaming call to the same model produced zero tokens with no
 * error) — without this, that failure mode would silently bypass withModelFallback
 * entirely, since the emptiness was only ever checked after it had already returned.
 *
 * For a reasoning model specifically, the same empty-completion failure has a known,
 * reproducible cause: its chat template lets the model decide, per turn, whether/how to open
 * its own `` block, and under temperature the very first sampled token can
 * land on an immediate close-and-stop instead — confirmed live by replaying an identical
 * failing request repeatedly. Prefilling the assistant turn with an already-open block (see
 * REASONING_ASSISTANT_PREFILL) removes that coin-flip — but only when thinking is enabled
 * (Effort On or default). Effort Off sets enable_thinking: false and skips prefill entirely;
 * delta.reasoning tokens are routed to the prose stream instead of the trace.
 * EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE retries before handing off to the next fallback
 * candidate (if any).
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
  let reply = ''
  let usedModel = profile.model
  let isFirstStream = true
  await withModelFallback(profile, async (candidate) => {
    usedModel = candidate.model
    streamingModels.set(jobId, candidate.model)
    const useReasoningTrace = proseStreamUsesReasoningTrace(candidate.model, chatTemplateKwargs)
    const usePrefill =
      prefillAssistant || shouldPrefillReasoning(candidate.model, chatTemplateKwargs)
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
      let reasoningLeakDetected = false
      /** Held back until resolveReasoningPeek decides — see looksLikeLeakedReasoningArtifact. */
      let reasoningAsAnswerPeek: string | null = ''
      const emitThinking = (text: string) => {
        sawReasoning = true
        publishThinking(jobId, text)
      }
      const emitAnswer = (text: string) => {
        reply += text
        publishToken(jobId, text)
      }
      const resolveReasoningPeek = () => {
        if (reasoningAsAnswerPeek === null) return
        const peeked = reasoningAsAnswerPeek
        reasoningAsAnswerPeek = null
        if (looksLikeLeakedReasoningArtifact(peeked)) {
          reasoningLeakDetected = true
        } else {
          emitAnswer(peeked)
        }
      }
      /**
       * Effort Off: Featherless may still emit delta.reasoning — treat it as IC prose, not trace,
       * but hold back the first few characters so looksLikeLeakedReasoningArtifact can screen out
       * the leaked-channel case before any of it is shown or stored (docs/reasoning-stream-research.md,
       * 2026-07-05).
       */
      const emitReasoningAsAnswer = (text: string) => {
        if (reasoningLeakDetected) return
        if (reasoningAsAnswerPeek === null) {
          emitAnswer(text)
          return
        }
        reasoningAsAnswerPeek += text
        if (reasoningAsAnswerPeek.length >= REASONING_LEAK_PEEK_CHARS) resolveReasoningPeek()
      }
      const emitReasoningDelta = (text: string) => {
        if (useReasoningTrace) emitThinking(text)
        else emitReasoningAsAnswer(text)
      }
      try {
        await new Promise<void>((resolve, reject) => {
          void streamInference(
            candidate,
            apiKey,
            candidateMessages,
            {
              onToken: (text) => {
                splitter.push(text, emitReasoningDelta, emitAnswer)
              },
              onReasoningToken: emitReasoningDelta,
              onDone: () => {
                splitter.flush(emitReasoningDelta, emitAnswer)
                resolveReasoningPeek()
                if (reasoningLeakDetected) {
                  reject(
                    new FeatherlessError(
                      503,
                      `${candidate.model} returned a leaked reasoning-channel artifact instead of prose`,
                    ),
                  )
                } else if (reply.trim()) {
                  resolve()
                } else if (sawReasoning && useReasoningTrace) {
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
              chatTemplateKwargs,
              idleTimeoutMs: streamIdleTimeoutMs(candidate.model, chatTemplateKwargs),
            },
          )
        })
        return
      } catch (err) {
        if (err instanceof JobCancelledError) throw err
        const isEmptyCompletion =
          err instanceof FeatherlessError &&
          (err.message.includes('empty completion') ||
            err.message.includes('no answer content') ||
            err.message.includes('leaked reasoning-channel'))
        if (!isEmptyCompletion || attempt === EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE) throw err
      }
    }
  })
  return { text: reply, model: usedModel }
}
