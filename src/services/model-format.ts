/**
 * Profile-aware format decisions — step 5 of docs/providers/format-probe-plan.md.
 *
 * Each decision has a pure `*For(profile, …)` core (unit-tested without a DB) and a thin
 * wrapper that looks the profile up in the global DB. For an unprofiled model every wrapper
 * falls back to exactly the pre-probe heuristics (name regex, hardcoded `<think>` tags), so
 * behavior only changes where a probe has produced evidence.
 */
import { getGlobalDb } from '../db/global-db.js'
import { getModelFormatProfile } from '../db/model-format-profile-store.js'
import type { ModelFormatProfile } from '../inference/format-probe.js'
import {
  isReasoningModel,
  streamIdleTimeoutMs,
  DEFAULT_IDLE_TIMEOUT_MS,
  REASONING_IDLE_TIMEOUT_MS,
} from '../inference/featherless.js'
import { DEFAULT_OPEN_TAGS, DEFAULT_CLOSE_TAGS } from '../inference/reasoning-stream.js'

/**
 * Last successfully probed profile for a Featherless model, or null. A profile with zero
 * successful calls carries no evidence (pre-fix rows could store one) and is treated as
 * absent rather than authoritative.
 */
export function getProbedProfile(model: string): ModelFormatProfile | null {
  const row = getModelFormatProfile(getGlobalDb(), 'featherless', model)
  const profile = row?.profile ?? null
  if (!profile || profile.callsSucceeded === 0) return null
  return profile
}

/**
 * Whether to prefill the assistant turn with `<think>\n` (REASONING_ASSISTANT_PREFILL).
 * The prefill exists to stop DeepSeek-family empty-completion coin flips when thinking is ON
 * (commit 3449c3f); with thinking off it actively breaks things — confirmed live, it routes
 * IC prose through delta.reasoning only, triggering false "reasoning but no answer content"
 * retries. So: never prefill unless the resolved kwargs explicitly enable thinking. For
 * profiled models the family comes from the probe record; expanding the prefill beyond the
 * deepseek family needs its own A/B evidence first — a probe can't measure the coin flip
 * (it's stochastic), so this stays family-gated rather than "any model that thinks".
 */
export function shouldPrefillThinkFor(
  profile: ModelFormatProfile | null,
  model: string,
  resolvedKwargs?: Record<string, unknown>,
): boolean {
  if (resolvedKwargs?.enable_thinking !== true) return false
  if (profile) return profile.family === 'deepseek' && profile.thinkingOnProduces !== false
  return isReasoningModel(model)
}

export function shouldPrefillThink(
  model: string,
  resolvedKwargs?: Record<string, unknown>,
): boolean {
  return shouldPrefillThinkFor(getProbedProfile(model), model, resolvedKwargs)
}

/**
 * Idle-timeout budget for a streaming call. Improves on the name-based guess in two probed
 * cases: a model that can't actually think gets the short budget even with thinking
 * requested, and a model that ignores the off switch (Kimi-style partial suppression) gets
 * the long budget even with thinking off — it will sit in a thinking phase regardless.
 */
export function streamIdleTimeoutMsFor(
  profile: ModelFormatProfile | null,
  model: string,
  resolvedKwargs?: Record<string, unknown>,
): number {
  if (!profile) return streamIdleTimeoutMs(model, resolvedKwargs)
  if (resolvedKwargs?.enable_thinking === true) {
    return profile.thinkingOnProduces === false
      ? DEFAULT_IDLE_TIMEOUT_MS
      : REASONING_IDLE_TIMEOUT_MS
  }
  return profile.thinkingOffSuppresses === false
    ? REASONING_IDLE_TIMEOUT_MS
    : DEFAULT_IDLE_TIMEOUT_MS
}

export function profiledStreamIdleTimeoutMs(
  model: string,
  resolvedKwargs?: Record<string, unknown>,
): number {
  return streamIdleTimeoutMsFor(getProbedProfile(model), model, resolvedKwargs)
}

/**
 * Tag lists for ReasoningStreamSplitter: the hardcoded `<think>` pair always stays (it is by
 * far the most common and costs nothing to watch for), plus the model's probe-confirmed
 * variant when it has one (`<seed:think>`, Gemma channels, …).
 */
export function splitterTagsFor(profile: ModelFormatProfile | null): {
  openTags: string[]
  closeTags: string[]
} {
  const openTags = [...DEFAULT_OPEN_TAGS]
  const closeTags = [...DEFAULT_CLOSE_TAGS]
  const tag = profile?.inlineThinkingTag
  if (tag) {
    if (!openTags.includes(tag.open)) openTags.push(tag.open)
    if (!closeTags.includes(tag.close)) closeTags.push(tag.close)
  }
  return { openTags, closeTags }
}

export function splitterTagsForModel(model: string): { openTags: string[]; closeTags: string[] } {
  return splitterTagsFor(getProbedProfile(model))
}
