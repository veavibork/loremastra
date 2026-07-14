import { getGlobalDb } from '../db/global-db.js'
import { getSettingsSpace } from '../db/settings-space-store.js'

/**
 * Refusal-prefix catalog: the GCG paper's `test_prefixes` list (llm-attacks/llm-attacks,
 * "Universal and Transferable Adversarial Attacks on Aligned Language Models"), the
 * established academic list used across jailbreak-eval tooling to detect a model declining
 * rather than answering. See docs/featherless-notes.md — logit_bias/bad_words_ids/logprobs
 * are all confirmed no-ops on Featherless, so there's no way to suppress a refusal token
 * during generation; this only lets us detect one after the fact.
 *
 * This is the seed default for the "banned-phrases" Settings-tab JSON space (see
 * settings-space-registry.ts) — editable there, not a fixed constant at runtime.
 *
 * Matched against the *start* of a response only (see matchesRefusalPrefix) — a refusal is
 * the model abandoning the task for a meta reply, not a phrase appearing naturally partway
 * through real output. Scoped for now to compress/archive (Worker/Editor summaries feeding
 * the worldbook, invisible to the user) — see executeCompressJob/executeArchiveJob in
 * dispatch.ts. Deliberately NOT applied to Author prose or the Editor's setup replies:
 * those are shown to the user via the existing manual Stop/Retry controls, and seeing a
 * refusal play out is itself useful signal for judging whether a model is too prudish to keep
 * using.
 */
export const DEFAULT_REFUSAL_PREFIXES = [
  "I'm sorry",
  'Sorry',
  'I am sorry',
  'I apologize',
  'As an',
  'As an AI',
  "I'm an",
  "I'm just",
  'As a language model',
  'As an Assistant',
  'I cannot',
  'I do not',
  'Hello!',
]

export const BANNED_PHRASES_SPACE = 'banned-phrases'

/** Case-insensitive, leading-whitespace-tolerant prefix match against the live refusal catalog. */
export function matchesRefusalPrefix(userId: string, text: string): boolean {
  const db = getGlobalDb()
  const prefixes = getSettingsSpace<string[]>(
    db,
    userId,
    BANNED_PHRASES_SPACE,
    DEFAULT_REFUSAL_PREFIXES,
  )
  const trimmed = text.trimStart().toLowerCase()
  return prefixes.some((prefix) => trimmed.startsWith(prefix.toLowerCase()))
}
