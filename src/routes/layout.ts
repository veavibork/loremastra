import { Hono } from "hono";
import { getGlobalDb } from "../db/global-db.js";
import type { AppVariables } from "../middleware/session-guard.js";
import {
  createLayoutConfig,
  getActiveLayoutConfig,
  listLayoutConfigs,
  updateLayoutConfigJson,
  setActiveLayoutConfig,
} from "../db/layout-config-store.js";
import { DEFAULT_LAYOUT_CONFIG } from "../services/layout.js";

export const layoutRoute = new Hono<{ Variables: AppVariables }>();

/** The active layout config, or the built-in default if the user has never saved one. */
layoutRoute.get("/", (c) => {
  const db = getGlobalDb();
  const active = getActiveLayoutConfig(db, c.get("userId"));
  if (active) return c.json({ id: active.id, name: active.name, config: JSON.parse(active.configJson) });
  return c.json({ id: null, name: "Default", config: DEFAULT_LAYOUT_CONFIG });
});

layoutRoute.get("/all", (c) => {
  const db = getGlobalDb();
  return c.json({ configs: listLayoutConfigs(db, c.get("userId")) });
});

/** Edits the active config in place, or creates+activates a new one if none exists yet. */
layoutRoute.patch("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { config?: unknown; name?: string };
  if (!body.config) return c.json({ error: "config is required" }, 400);

  const db = getGlobalDb();
  const userId = c.get("userId");
  const configJson = JSON.stringify(body.config);

  const active = getActiveLayoutConfig(db, userId);
  const saved = active
    ? updateLayoutConfigJson(db, active.id, configJson)
    : createLayoutConfig(db, { userId, name: body.name?.trim() || "Default", configJson, isActive: true });

  return c.json({ id: saved.id, name: saved.name, config: JSON.parse(saved.configJson) });
});

layoutRoute.post("/:id/activate", (c) => {
  const db = getGlobalDb();
  setActiveLayoutConfig(db, c.get("userId"), c.req.param("id"));
  return c.json({ ok: true });
});
