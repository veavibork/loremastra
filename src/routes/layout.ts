import { Hono } from "hono";
import { getGlobalDb } from "../db/global-db.js";
import { getOrCreateDefaultUser } from "../db/user-store.js";
import {
  createLayoutConfig,
  getActiveLayoutConfig,
  listLayoutConfigs,
  updateLayoutConfigJson,
  setActiveLayoutConfig,
} from "../db/layout-config-store.js";
import { DEFAULT_LAYOUT_CONFIG } from "../services/layout.js";

export const layoutRoute = new Hono();

/** The active layout config, or the built-in default if the user has never saved one. */
layoutRoute.get("/", (c) => {
  const db = getGlobalDb();
  const user = getOrCreateDefaultUser(db);
  const active = getActiveLayoutConfig(db, user.id);
  if (active) return c.json({ id: active.id, name: active.name, config: JSON.parse(active.configJson) });
  return c.json({ id: null, name: "Default", config: DEFAULT_LAYOUT_CONFIG });
});

layoutRoute.get("/all", (c) => {
  const db = getGlobalDb();
  const user = getOrCreateDefaultUser(db);
  return c.json({ configs: listLayoutConfigs(db, user.id) });
});

/** Edits the active config in place, or creates+activates a new one if none exists yet. */
layoutRoute.patch("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { config?: unknown; name?: string };
  if (!body.config) return c.json({ error: "config is required" }, 400);

  const db = getGlobalDb();
  const user = getOrCreateDefaultUser(db);
  const configJson = JSON.stringify(body.config);

  const active = getActiveLayoutConfig(db, user.id);
  const saved = active
    ? updateLayoutConfigJson(db, active.id, configJson)
    : createLayoutConfig(db, { userId: user.id, name: body.name?.trim() || "Default", configJson, isActive: true });

  return c.json({ id: saved.id, name: saved.name, config: JSON.parse(saved.configJson) });
});

layoutRoute.post("/:id/activate", (c) => {
  const db = getGlobalDb();
  const user = getOrCreateDefaultUser(db);
  setActiveLayoutConfig(db, user.id, c.req.param("id"));
  return c.json({ ok: true });
});
