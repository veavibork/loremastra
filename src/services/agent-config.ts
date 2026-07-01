import { getGlobalDb } from "../db/global-db.js";
import { getAgentConfigOverride, type AgentRole } from "../db/agent-config-store.js";
import { DEFAULT_AUTHOR_PROFILE, DEFAULT_WORKER_PROFILE, DEFAULT_EDITOR_PROFILE, type AgentProfile } from "../config.js";

const DEFAULTS: Record<AgentRole, AgentProfile> = {
  author: DEFAULT_AUTHOR_PROFILE,
  worker: DEFAULT_WORKER_PROFILE,
  editor: DEFAULT_EDITOR_PROFILE,
};

/** Config > Agents override if the user has saved one, else the built-in default from config.ts. */
export function getAgentProfile(role: AgentRole): AgentProfile {
  const override = getAgentConfigOverride(getGlobalDb(), role);
  return override ?? DEFAULTS[role];
}
