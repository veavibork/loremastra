import { Hono } from "hono";
import { getGlobalDb } from "../db/global-db.js";
import { getOrCreateDefaultUser } from "../db/user-store.js";
import { listBannedPhrases, createBannedPhrase, deleteBannedPhrase } from "../db/banned-phrase-store.js";

export const bannedPhrasesRoute = new Hono();

bannedPhrasesRoute.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

bannedPhrasesRoute.get("/", (c) => {
  const db = getGlobalDb();
  const user = getOrCreateDefaultUser(db);
  return c.json({ phrases: listBannedPhrases(db, user.id) });
});

bannedPhrasesRoute.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { phrase?: string };
  const phrase = body.phrase?.trim();
  if (!phrase) return c.json({ error: "phrase is required" }, 400);

  const db = getGlobalDb();
  const user = getOrCreateDefaultUser(db);
  try {
    const created = createBannedPhrase(db, user.id, phrase);
    return c.json({ phrase: created });
  } catch {
    return c.json({ error: "phrase already banned" }, 409);
  }
});

bannedPhrasesRoute.delete("/:id", (c) => {
  const db = getGlobalDb();
  deleteBannedPhrase(db, c.req.param("id"));
  return c.json({ ok: true });
});
