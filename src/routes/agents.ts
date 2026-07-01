import { Hono } from "hono";
import { getGlobalDb } from "../db/global-db.js";
import { getOrCreateDefaultUser } from "../db/user-store.js";
import { setAgentConfigOverride, type AgentRole } from "../db/agent-config-store.js";
import { getAgentProfile } from "../services/agent-config.js";
import type { AgentProfile } from "../config.js";

export const agentsRoute = new Hono();

const ROLES: AgentRole[] = ["author", "worker", "editor"];

agentsRoute.get("/", (c) => {
  const profiles: Record<AgentRole, AgentProfile> = {
    author: getAgentProfile("author"),
    worker: getAgentProfile("worker"),
    editor: getAgentProfile("editor"),
  };
  return c.json({ profiles });
});

agentsRoute.patch("/:role", async (c) => {
  const role = c.req.param("role") as AgentRole;
  if (!ROLES.includes(role)) return c.json({ error: `invalid role "${role}"` }, 400);

  const body = (await c.req.json().catch(() => ({}))) as Partial<AgentProfile>;
  const current = getAgentProfile(role);
  const next: AgentProfile = {
    model: body.model?.trim() || current.model,
    temperature: typeof body.temperature === "number" ? body.temperature : current.temperature,
    responseLimit: typeof body.responseLimit === "number" ? body.responseLimit : current.responseLimit,
    contextLimit: typeof body.contextLimit === "number" ? body.contextLimit : current.contextLimit,
    fallbackModels: Array.isArray(body.fallbackModels) ? body.fallbackModels : current.fallbackModels,
  };

  const db = getGlobalDb();
  const user = getOrCreateDefaultUser(db);
  setAgentConfigOverride(db, role, user.id, next);

  return c.json({ profile: next });
});
