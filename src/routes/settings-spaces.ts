import { Hono } from "hono";
import { getGlobalDb } from "../db/global-db.js";
import type { AppVariables } from "../middleware/session-guard.js";
import { getSettingsSpace, saveSettingsSpace, revertSettingsSpace } from "../db/settings-space-store.js";
import { getSpaceDefault, isKnownSpace } from "../services/settings-space-registry.js";

export const settingsSpacesRoute = new Hono<{ Variables: AppVariables }>();

settingsSpacesRoute.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

settingsSpacesRoute.get("/:space", (c) => {
  const space = c.req.param("space");
  if (!isKnownSpace(space)) return c.json({ error: `unknown settings space: ${space}` }, 404);

  const db = getGlobalDb();
  const value = getSettingsSpace(db, c.get("userId"), space, getSpaceDefault(space));
  return c.json({ space, value });
});

settingsSpacesRoute.put("/:space", async (c) => {
  const space = c.req.param("space");
  if (!isKnownSpace(space)) return c.json({ error: `unknown settings space: ${space}` }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
  if (body.value === undefined) return c.json({ error: "value is required" }, 400);

  const db = getGlobalDb();
  const value = saveSettingsSpace(db, c.get("userId"), space, body.value);
  return c.json({ space, value });
});

settingsSpacesRoute.post("/:space/revert", (c) => {
  const space = c.req.param("space");
  if (!isKnownSpace(space)) return c.json({ error: `unknown settings space: ${space}` }, 404);

  const db = getGlobalDb();
  const value = revertSettingsSpace(db, c.get("userId"), space);
  if (value === null) return c.json({ error: "nothing to revert to" }, 409);
  return c.json({ space, value });
});
