try {
  process.loadEnvFile();
} catch {
  // no .env present; rely on process.env as-is
}

export interface AgentProfile {
  model: string;
  temperature: number;
  responseLimit: number;
  contextLimit: number;
  /** Ranked-choice fallback (loremaster.md's Provider Abstraction section) — tried in order if model is unavailable (see FeatherlessError/withModelFallback in inference/featherless.ts). Empty/absent means no fallback. */
  fallbackModels?: string[];
  /** Optional sampler params (Featherless completions API) — omitted from the request body entirely when undefined, not sent as null. */
  presencePenalty?: number;
  frequencyPenalty?: number;
  repetitionPenalty?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  /** The model_configs row backing `model` above, when built from Config > Agents' DB-backed list — lets withModelFallback attribute success/fail/token stats to the right row. Absent for the hardcoded defaults below (only used as a last resort if that table is somehow empty). */
  configId?: string;
  /** Parallel to fallbackModels — the model_configs row id for each fallback candidate, same order. */
  fallbackConfigIds?: string[];
}

// Defaults, used when Config > Agents has no saved override yet (src/services/agent-config.ts
// reads from the DB first and falls back to these). Values match lorepebble's server-config.json
// — proven to work on Featherless.
export const DEFAULT_AUTHOR_PROFILE: AgentProfile = {
  model: process.env.AUTHOR_MODEL ?? "deepseek-ai/DeepSeek-V4-Pro",
  temperature: 1.0,
  responseLimit: 4096,
  contextLimit: 32000,
};

// Deliberately not a "Heretic"/uncensored variant — the worker only summarizes
// existing text, it doesn't generate new creative/explicit content, so there's
// no guardrails reason to trade tool-calling reliability for permissiveness
// here (see docs/featherless-notes.md). Hermes is specifically tuned for
// function-calling.
export const DEFAULT_WORKER_PROFILE: AgentProfile = {
  model: process.env.WORKER_MODEL ?? "NousResearch/Hermes-3-Llama-3.1-8B",
  temperature: 0.5,
  responseLimit: 2048,
  contextLimit: 16000,
};

// Value matches lorepebble's server-config.json editor profile.
export const DEFAULT_EDITOR_PROFILE: AgentProfile = {
  model: process.env.EDITOR_MODEL ?? "deepseek-ai/DeepSeek-V4-Pro",
  temperature: 0.7,
  responseLimit: 4096,
  contextLimit: 32000,
};
