/**
 * Format hypothesis corpus — step 2 of docs/providers/format-probe-plan.md.
 *
 * Candidate thinking tags, leak tokens, chat_template_kwargs keys, prompt-level thinking
 * controls, and model-family patterns, mined from community template presets and our own
 * probe findings. RULE (agreed 2026-07-19): these are hypotheses the format probe TESTS,
 * never config we apply — only probe observations become stored truth (the per-model
 * format profile, plan step 4).
 *
 * Per-entry source tags:
 * - 'st'    SillyTavern default presets (instruct + reasoning), release branch, read 2026-07-19
 * - 'kai'   KoboldAI Lite `instructpresets` + `hardcoded_think_closers`, main branch, read 2026-07-19
 * - 'guide' LLM Settings Guide HF space (local snapshot: Desktop/reference/llm-settings-guide.md)
 * - 'featherless-docs' featherless.ai/docs/chat-template-kwargs
 * - 'probe' our own empirical findings (docs/providers/model-shape-probe-2026-07-17.md,
 *           docs/providers/reasoning-stream-research.md, docs/development.md A/B notes)
 * - 'community' widely-reported template behavior with no primary source in the above —
 *           the weakest tier; a probe hit is the only thing that promotes it
 */

export type HypothesisSource =
  | 'st'
  | 'kai'
  | 'guide'
  | 'featherless-docs'
  | 'probe'
  | 'community'

export interface ThinkingTagHypothesis {
  /** Open-marker spellings to try — sources sometimes disagree; the probe decides. */
  open: string[]
  close: string
  families: string[]
  sources: HypothesisSource[]
  notes?: string
}

/**
 * Candidate inline thinking-block markers (shape B in the 2026-07-17 taxonomy). The
 * ReasoningStreamSplitter currently only knows `<think>`; anything here that a probe
 * confirms for a model becomes splitter data via its format profile (plan step 5).
 */
export const THINKING_TAG_HYPOTHESES: ThinkingTagHypothesis[] = [
  {
    open: ['<think>'],
    close: '</think>',
    families: ['deepseek', 'qwen', 'glm', 'hermes', 'minimax', 'exaone'],
    sources: ['st', 'kai', 'guide', 'probe'],
    notes:
      'The dominant convention. Confirmed inline on Qwen3-8B via Featherless (probe ' +
      '2026-07-17). DeepSeek/Kimi on Featherless emit a separate `reasoning` delta field ' +
      'instead (shape A); GLM leaks reasoning unmarked (shape C) unless suppressed.',
  },
  {
    open: ['<|channel>thought', '<|channel|>thought'],
    close: '<channel|>',
    families: ['gemma4'],
    sources: ['st', 'kai', 'guide'],
    notes:
      'Sources disagree on the open spelling (ST/KAI: <|channel>thought, guide: ' +
      '<|channel|>thought) — probe decides. KAI additionally prefixes <|think|> when ' +
      'force-enabling thinking.',
  },
  {
    open: ['<|start|>assistant<|channel|>analysis<|message|>'],
    close: '<|start|>assistant<|channel|>final<|message|>',
    families: ['gpt-oss'],
    sources: ['st', 'guide'],
    notes:
      'OpenAI Harmony channel markers. Guide: reasoning cannot be disabled on GPT-OSS. Our ' +
      'probe saw gpt-oss-20b as shape A (separate reasoning field) on Featherless, so the ' +
      'inline form may never surface via /chat/completions there.',
  },
  {
    open: ['<seed:think>'],
    close: '</seed:think>',
    families: ['seed-oss'],
    sources: ['kai'],
  },
  {
    open: ['<|START_THINKING|>'],
    close: '<|END_THINKING|>',
    families: ['cohere'],
    sources: ['kai'],
    notes: 'Close tag from KAI hardcoded_think_closers; open inferred from Cohere templates.',
  },
  {
    open: ['◁think▷'],
    close: '◁/think▷',
    families: ['kimi'],
    sources: ['community'],
    notes:
      'Moonshot HF chat-template markers. Unverified here — Featherless serves Kimi with a ' +
      'separate `reasoning` field (probe 2026-07-17), so this may only matter on raw ' +
      '/completions.',
  },
]

export interface LeakTokenHypothesis {
  token: string
  kind: 'eos' | 'role-marker'
  families: string[]
  sources: HypothesisSource[]
  notes?: string
  /** False = probe-time scan only; too false-positive-prone against real prose (see [INST]). */
  runtimeScan?: boolean
}

/**
 * Template tokens that should never appear in answer text. Probe output (and later the
 * runtime tripwire, plan step 6) scans completions against this catalog. Thinking-tag
 * open/close markers are scanned too — see allLeakScanTokens().
 */
export const LEAK_TOKEN_HYPOTHESES: LeakTokenHypothesis[] = [
  // --- end-of-turn / EOS ---
  {
    token: '<|im_end|>',
    kind: 'eos',
    families: ['chatml', 'qwen', 'hermes', 'kimi'],
    sources: ['st', 'kai', 'probe'],
    notes: 'Confirmed leaking from Hermes-3-Llama-3.1-8B on Featherless (A/B, 2026-07-19).',
  },
  { token: '<|eot_id|>', kind: 'eos', families: ['llama3', 'hermes'], sources: ['st', 'kai'] },
  { token: '<|eot|>', kind: 'eos', families: ['llama4'], sources: ['kai'] },
  {
    token: '<｜end▁of▁sentence｜>',
    kind: 'eos',
    families: ['deepseek'],
    sources: ['st', 'kai'],
    notes:
      'Fullwidth vertical bars (U+FF5C) and lower-one-eighth blocks (U+2581) — a naive ' +
      'ASCII scan misses it.',
  },
  { token: '</s>', kind: 'eos', families: ['mistral', 'legacy-sentencepiece'], sources: ['kai'] },
  { token: '<end_of_turn>', kind: 'eos', families: ['gemma'], sources: ['kai'] },
  { token: '<turn|>', kind: 'eos', families: ['gemma4'], sources: ['st', 'kai'] },
  { token: '<|end|>', kind: 'eos', families: ['phi', 'gpt-oss'], sources: ['st', 'kai'] },
  { token: '<|END_OF_TURN_TOKEN|>', kind: 'eos', families: ['cohere'], sources: ['kai'] },
  { token: '<|end_of_text|>', kind: 'eos', families: ['granite', 'llama3'], sources: ['kai'] },
  { token: '<seed:eos>', kind: 'eos', families: ['seed-oss'], sources: ['kai'] },

  // --- next-turn role markers (a model running past its stop token emits these) ---
  { token: '<|im_start|>', kind: 'role-marker', families: ['chatml', 'qwen', 'hermes'], sources: ['st', 'kai'] },
  { token: '<｜User｜>', kind: 'role-marker', families: ['deepseek'], sources: ['st', 'kai'] },
  { token: '<｜Assistant｜>', kind: 'role-marker', families: ['deepseek'], sources: ['st', 'kai'] },
  { token: '<|start_header_id|>', kind: 'role-marker', families: ['llama3', 'hermes'], sources: ['st', 'kai'] },
  { token: '<|header_start|>', kind: 'role-marker', families: ['llama4'], sources: ['kai'] },
  { token: '<|im_user|>', kind: 'role-marker', families: ['kimi'], sources: ['st', 'kai'] },
  { token: '<|im_assistant|>', kind: 'role-marker', families: ['kimi'], sources: ['st', 'kai'] },
  { token: '<|im_middle|>', kind: 'role-marker', families: ['kimi'], sources: ['st', 'kai'] },
  { token: '<|user|>', kind: 'role-marker', families: ['glm', 'metharme', 'phi'], sources: ['st', 'kai'] },
  { token: '<|assistant|>', kind: 'role-marker', families: ['glm', 'phi'], sources: ['st', 'kai'] },
  { token: '<|system|>', kind: 'role-marker', families: ['glm', 'metharme', 'phi'], sources: ['kai'] },
  { token: '<start_of_turn>', kind: 'role-marker', families: ['gemma'], sources: ['kai'] },
  { token: '<|turn>', kind: 'role-marker', families: ['gemma4'], sources: ['st', 'kai'] },
  { token: '<|start_of_role|>', kind: 'role-marker', families: ['granite'], sources: ['kai'] },
  { token: '<seed:bos>', kind: 'role-marker', families: ['seed-oss'], sources: ['kai'] },
  { token: '<|START_OF_TURN_TOKEN|>', kind: 'role-marker', families: ['cohere'], sources: ['kai'] },
  { token: '<|message|>', kind: 'role-marker', families: ['gpt-oss'], sources: ['st'] },
  {
    token: '[INST]',
    kind: 'role-marker',
    families: ['mistral', 'llama2'],
    sources: ['kai'],
    runtimeScan: false,
    notes:
      'Plain-bracket token — collides with legit bracketed prose and our own bracket-note ' +
      'guidance convention. Probe-time scan only; too false-positive-prone for runtime.',
  },
]

export interface KwargHypothesis {
  key: string
  type: 'boolean' | 'number'
  families: string[]
  sources: HypothesisSource[]
  notes?: string
}

/** chat_template_kwargs keys the probe exercises in both directions (on AND off, n>=2). */
export const KWARG_HYPOTHESES: KwargHypothesis[] = [
  {
    key: 'enable_thinking',
    type: 'boolean',
    families: ['qwen', 'glm', 'gemma4'],
    sources: ['featherless-docs', 'probe'],
    notes:
      'GLM-4.7-Flash suppression confirmed live (probe 2026-07-17). DeepSeek honored it on ' +
      'Featherless despite the docs scoping it elsewhere. Kimi-K2.7-Code only partially ' +
      'honors it (residual reasoning).',
  },
  {
    key: 'thinking',
    type: 'boolean',
    families: ['deepseek', 'kimi'],
    sources: ['featherless-docs', 'probe'],
    notes: 'GLM ignores this key entirely (probe 2026-07-17) — kwarg keys are not interchangeable.',
  },
  {
    key: 'thinking_budget',
    type: 'number',
    families: ['qwen'],
    sources: ['featherless-docs'],
    notes:
      'Docs say "compatible models" without a list — treat as unverified everywhere until a ' +
      'probe shows the budget actually bounds reasoning length.',
  },
  {
    key: 'preserve_thinking',
    type: 'boolean',
    families: ['kimi', 'qwen'],
    sources: ['featherless-docs'],
    notes: 'Multi-turn reasoning retention; docs call it required for agentic tool use.',
  },
  {
    key: 'clear_thinking',
    type: 'boolean',
    families: ['glm'],
    sources: ['featherless-docs'],
    notes: "GLM's inverse spelling of preserve_thinking — false retains reasoning across turns.",
  },
]

export interface PromptControlHypothesis {
  kind: 'system-or-user-text' | 'assistant-prefill'
  text: string
  effect: 'disable-thinking' | 'enable-thinking'
  families: string[]
  sources: HypothesisSource[]
  notes?: string
}

/**
 * Prompt-level thinking controls — levers that live in message content rather than request
 * kwargs. Useful where a family ignores its kwargs (Kimi) or on providers with no kwarg
 * pass-through.
 */
export const PROMPT_CONTROL_HYPOTHESES: PromptControlHypothesis[] = [
  {
    kind: 'system-or-user-text',
    text: '/no_think',
    effect: 'disable-thinking',
    families: ['qwen'],
    sources: ['guide'],
  },
  {
    kind: 'system-or-user-text',
    text: '/nothink',
    effect: 'disable-thinking',
    families: ['glm'],
    sources: ['guide', 'kai'],
    notes: 'KAI appends it as a user-turn suffix; note the spelling differs from Qwen’s.',
  },
  {
    kind: 'assistant-prefill',
    text: '<think>\n\n</think>\n',
    effect: 'disable-thinking',
    families: ['chatml', 'qwen'],
    sources: ['kai'],
    notes: 'An already-closed empty thinking block ("ChatML Non-Thinking").',
  },
  {
    kind: 'assistant-prefill',
    text: '</think>',
    effect: 'disable-thinking',
    families: ['deepseek', 'glm'],
    sources: ['kai'],
    notes: 'Bare close tag as prefill (DeepSeek v3.1+ / GLM-4.7 non-thinking presets).',
  },
  {
    kind: 'assistant-prefill',
    text: '<think>\n',
    effect: 'enable-thinking',
    families: ['deepseek'],
    sources: ['probe', 'guide'],
    notes:
      'Our production REASONING_ASSISTANT_PREFILL (src/queue/provider-dispatch.ts). The ' +
      "guide's reasoning-prefill tricks rely on the same mechanism.",
  },
]

export interface FamilyPattern {
  family: string
  /** Case-insensitive regex source matched against the full model id. First match wins. */
  pattern: string
  sources: HypothesisSource[]
  notes?: string
}

/**
 * Model-id → family mapping candidates. Order matters: more specific families first
 * (Hermes ids contain "Llama"; Kimi ids contain "moonshotai"). Cross-check against
 * Featherless's API-provided `model_class` where available — on disagreement, the probe
 * result is the tiebreaker.
 */
export const FAMILY_PATTERNS: FamilyPattern[] = [
  { family: 'hermes', pattern: 'hermes', sources: ['st', 'kai', 'guide'] },
  { family: 'kimi', pattern: 'kimi|moonshot', sources: ['st', 'kai', 'probe'] },
  { family: 'deepseek', pattern: 'deepseek', sources: ['st', 'kai', 'guide', 'probe'] },
  { family: 'qwen', pattern: 'qwen|qwq', sources: ['st', 'kai', 'guide', 'probe'] },
  { family: 'glm', pattern: 'glm|zai-org', sources: ['st', 'kai', 'guide', 'probe'] },
  { family: 'gemma4', pattern: 'gemma-?4', sources: ['st', 'kai', 'guide', 'probe'] },
  { family: 'gemma', pattern: 'gemma', sources: ['st', 'kai', 'guide'] },
  { family: 'gpt-oss', pattern: 'gpt-oss|harmony', sources: ['st', 'guide', 'probe'] },
  { family: 'mistral', pattern: 'mistral|mixtral|nemo|tekken', sources: ['st', 'kai', 'guide'] },
  { family: 'llama4', pattern: 'llama-?4', sources: ['st', 'kai'] },
  { family: 'llama3', pattern: 'llama-?3', sources: ['st', 'kai'] },
  { family: 'cohere', pattern: 'command-?[ra]|c4ai|cohere', sources: ['st', 'kai', 'guide'] },
  { family: 'seed-oss', pattern: 'seed-?oss', sources: ['kai', 'guide'] },
  { family: 'minimax', pattern: 'minimax', sources: ['guide'] },
  { family: 'phi', pattern: 'phi-?[0-9]', sources: ['st', 'kai'] },
  { family: 'granite', pattern: 'granite', sources: ['kai', 'guide'] },
  { family: 'exaone', pattern: 'exaone', sources: ['guide'] },
  { family: 'chatml', pattern: '.^', sources: ['st', 'kai'], notes: 'Fallback convention, never matched by id — assigned only by probe observation.' },
]

/** First matching family for a model id, or null. */
export function familyForModelId(modelId: string): string | null {
  for (const { family, pattern } of FAMILY_PATTERNS) {
    if (new RegExp(pattern, 'i').test(modelId)) return family
  }
  return null
}

/** Every literal the probe scans completions for: leak tokens + all thinking-tag markers. */
export function allLeakScanTokens(): string[] {
  const out = new Set<string>()
  for (const t of LEAK_TOKEN_HYPOTHESES) out.add(t.token)
  for (const t of THINKING_TAG_HYPOTHESES) {
    for (const open of t.open) out.add(open)
    out.add(t.close)
  }
  return [...out]
}

/** Same union minus tokens marked runtimeScan: false — what the drift tripwire scans live prose with. */
export function runtimeLeakScanTokens(): string[] {
  const excluded = new Set(
    LEAK_TOKEN_HYPOTHESES.filter((t) => t.runtimeScan === false).map((t) => t.token),
  )
  return allLeakScanTokens().filter((t) => !excluded.has(t))
}
