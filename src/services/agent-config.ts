import type Database from "better-sqlite3";
import { getGlobalDb } from "../db/global-db.js";
import { getOrCreateDefaultUser } from "../db/user-store.js";
import { getAgentConfigOverride, type AgentRole } from "../db/agent-config-store.js";
import { listModelConfigs, createModelConfig, type ModelConfigRow } from "../db/model-config-store.js";
import { DEFAULT_AUTHOR_PROFILE, DEFAULT_WORKER_PROFILE, DEFAULT_EDITOR_PROFILE, type AgentProfile } from "../config.js";

export type { AgentRole } from "../db/model-config-store.js";

const DEFAULTS: Record<AgentRole, AgentProfile> = {
  author: DEFAULT_AUTHOR_PROFILE,
  worker: DEFAULT_WORKER_PROFILE,
  editor: DEFAULT_EDITOR_PROFILE,
};

const ROLE_ORDER: AgentRole[] = ["author", "worker", "editor"];

/**
 * One-time migration from the old one-row-per-role `agent_configs` table to the new flat,
 * reorderable `model_configs` list (Config > Agents rebuild) — runs only when a user has no
 * model_configs rows yet, so it never clobbers anything already set up under the new system.
 * Preserves whatever was actually live (a saved override, or the config.ts default) as one
 * row per role, in author/worker/editor order, rather than silently resetting anyone's
 * working setup. A role's saved fallbackModels become their own rows, checked for that role
 * only — see model_configs' schema comment for why these aren't deduped by model id even
 * when the same model string repeats across rows.
 */
function ensureModelConfigsSeeded(db: Database.Database, userId: string): void {
  if (listModelConfigs(db, userId).length > 0) return;

  for (const role of ROLE_ORDER) {
    const profile = getAgentConfigOverride(db, role) ?? DEFAULTS[role];
    const roleFlags = { useAuthor: role === "author", useEditor: role === "editor", useWorker: role === "worker" };
    createModelConfig(db, userId, {
      provider: "featherless",
      model: profile.model,
      temperature: profile.temperature,
      responseLimit: profile.responseLimit,
      contextLimit: profile.contextLimit,
      active: true,
      ...roleFlags,
    });
    for (const fallbackModel of profile.fallbackModels ?? []) {
      createModelConfig(db, userId, {
        provider: "featherless",
        model: fallbackModel,
        temperature: profile.temperature,
        responseLimit: profile.responseLimit,
        contextLimit: profile.contextLimit,
        active: true,
        ...roleFlags,
      });
    }
  }
}

function roleFlag(row: ModelConfigRow, role: AgentRole): boolean {
  if (role === "author") return row.useAuthor;
  if (role === "editor") return row.useEditor;
  return row.useWorker;
}

/**
 * Builds the ranked-fallback AgentProfile for a role from the model_configs list: every
 * active row with that role's flag set, in sort_order, primary first and the rest as
 * fallbackModels. Falls back to config.ts's hardcoded default only if the table is somehow
 * empty for this role (e.g. every row for it got deactivated) — real day-to-day fallback
 * behavior comes entirely from the ordered row list now, not this constant.
 */
export function getAgentProfile(role: AgentRole): AgentProfile {
  const db = getGlobalDb();
  const user = getOrCreateDefaultUser(db);
  ensureModelConfigsSeeded(db, user.id);

  const rows = listModelConfigs(db, user.id).filter((r) => r.active && roleFlag(r, role));
  if (!rows.length) return DEFAULTS[role];

  const [primary, ...fallbacks] = rows;
  return {
    provider: primary.provider,
    model: primary.model,
    temperature: primary.temperature,
    responseLimit: primary.responseLimit,
    contextLimit: primary.contextLimit,
    presencePenalty: primary.presencePenalty ?? undefined,
    frequencyPenalty: primary.frequencyPenalty ?? undefined,
    repetitionPenalty: primary.repetitionPenalty ?? undefined,
    topP: primary.topP ?? undefined,
    topK: primary.topK ?? undefined,
    minP: primary.minP ?? undefined,
    concurrencyCost: primary.concurrencyCost ?? DEFAULTS[role].concurrencyCost,
    fallbackModels: fallbacks.map((f) => f.model),
    configId: primary.id,
    fallbackConfigIds: fallbacks.map((f) => f.id),
  };
}
