import { Hono } from "hono";
import { getGlobalDb } from "../db/global-db.js";
import { getOrCreateDefaultUser } from "../db/user-store.js";
import { createSession } from "../db/session-store.js";

export const sessionsRoute = new Hono();

// Deliberately exempt from src/middleware/session-guard.ts (chicken-and-egg: nothing has
// a session id to present until this call returns one). The guard skips this exact path.
sessionsRoute.post("/claim", (c) => {
  const db = getGlobalDb();
  const user = getOrCreateDefaultUser(db);
  const session = createSession(db, user.id);
  return c.json({ sessionId: session.id, claimedAt: session.createdAt });
});
