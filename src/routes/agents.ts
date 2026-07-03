import { Hono, type Context } from "hono";
import { getGlobalDb } from "../db/global-db.js";
import type { AppVariables } from "../middleware/session-guard.js";
import {
  listModelConfigs,
  createModelConfig,
  updateModelConfig,
  deleteModelConfig,
  reorderModelConfigs,
  type ModelConfigInput,
} from "../db/model-config-store.js";
import { getAgentProfile } from "../services/agent-config.js";
import { listModels } from "../inference/featherless-models.js";
import { listTextModels } from "../inference/horde.js";
import { getDecryptedFeatherlessKey, getDecryptedHordeKey } from "../db/user-store.js";

export const agentsRoute = new Hono<{ Variables: AppVariables }>();

export interface CatalogModel {
  id: string;
  contextLength?: number;
  concurrencyCost?: number;
  toolUse?: boolean;
}

// Provider-dispatching model catalog lookup, used by Config > Agents' "Fetch models" action.
agentsRoute.get("/models", async (c) => {
  const provider = c.req.query("provider") ?? "featherless";
  const db = getGlobalDb();
  const userId = c.get("userId");
  if (provider === "featherless") {
    const apiKey = getDecryptedFeatherlessKey(db, userId);
    if (!apiKey) return c.json({ error: "No Featherless API key configured — set one in the Agents tab" }, 400);
    const models = await listModels(apiKey, { perPage: 200 });
    const catalog: CatalogModel[] = models.map((m) => ({
      id: m.id,
      contextLength: m.contextLength,
      concurrencyCost: m.concurrencyCost,
      toolUse: m.toolUse,
    }));
    return c.json({ models: catalog });
  }
  if (provider === "horde") {
    const models = await listTextModels(getDecryptedHordeKey(db, userId));
    const catalog: CatalogModel[] = models.map((m) => ({ id: m.name }));
    return c.json({ models: catalog });
  }
  return c.json({ error: `unsupported provider: ${provider}` }, 400);
});

const DEFAULT_NEW_MODEL: ModelConfigInput = {
  provider: "featherless",
  model: "",
  temperature: 1.0,
  responseLimit: 4096,
  contextLimit: 32000,
  useAuthor: false,
  useEditor: false,
  useWorker: false,
  active: true,
};

function toPatch(body: Record<string, unknown>): Partial<ModelConfigInput> {
  const patch: Partial<ModelConfigInput> = {};
  if (body.provider === "featherless" || body.provider === "horde") patch.provider = body.provider;
  if (typeof body.model === "string") patch.model = body.model.trim();
  if (typeof body.temperature === "number") patch.temperature = body.temperature;
  if (typeof body.responseLimit === "number") patch.responseLimit = body.responseLimit;
  if (typeof body.contextLimit === "number") patch.contextLimit = body.contextLimit;
  if (typeof body.presencePenalty === "number" || body.presencePenalty === null) patch.presencePenalty = body.presencePenalty;
  if (typeof body.frequencyPenalty === "number" || body.frequencyPenalty === null) patch.frequencyPenalty = body.frequencyPenalty;
  if (typeof body.repetitionPenalty === "number" || body.repetitionPenalty === null) patch.repetitionPenalty = body.repetitionPenalty;
  if (typeof body.topP === "number" || body.topP === null) patch.topP = body.topP;
  if (typeof body.topK === "number" || body.topK === null) patch.topK = body.topK;
  if (typeof body.minP === "number" || body.minP === null) patch.minP = body.minP;
  if (typeof body.concurrencyCost === "number" || body.concurrencyCost === null) patch.concurrencyCost = body.concurrencyCost;
  if (typeof body.useAuthor === "boolean") patch.useAuthor = body.useAuthor;
  if (typeof body.useEditor === "boolean") patch.useEditor = body.useEditor;
  if (typeof body.useWorker === "boolean") patch.useWorker = body.useWorker;
  if (typeof body.active === "boolean") patch.active = body.active;
  return patch;
}

// Ensures Config > Agents always reflects the current live state (including the one-time
// migration from the old per-role table) before any read/write below touches the list.
function ensureSeeded(c: Context<{ Variables: AppVariables }>): { db: ReturnType<typeof getGlobalDb>; userId: string } {
  const db = getGlobalDb();
  const userId = c.get("userId");
  getAgentProfile(userId, "author"); // triggers ensureModelConfigsSeeded as a side effect
  return { db, userId };
}

agentsRoute.get("/", (c) => {
  const { db, userId } = ensureSeeded(c);
  return c.json({ configs: listModelConfigs(db, userId) });
});

agentsRoute.post("/", (c) => {
  const { db, userId } = ensureSeeded(c);
  const created = createModelConfig(db, userId, DEFAULT_NEW_MODEL);
  return c.json({ config: created });
});

agentsRoute.patch("/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { db } = ensureSeeded(c);
  const updated = updateModelConfig(db, c.req.param("id"), toPatch(body));
  if (!updated) return c.json({ error: "model config not found" }, 404);
  return c.json({ config: updated });
});

agentsRoute.delete("/:id", (c) => {
  const { db } = ensureSeeded(c);
  deleteModelConfig(db, c.req.param("id"));
  return c.json({ ok: true });
});

agentsRoute.post("/reorder", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { orderedIds?: string[] };
  if (!Array.isArray(body.orderedIds)) return c.json({ error: "orderedIds is required" }, 400);
  const { db, userId } = ensureSeeded(c);
  reorderModelConfigs(db, userId, body.orderedIds);
  return c.json({ configs: listModelConfigs(db, userId) });
});
