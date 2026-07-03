import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { getGlobalDb } from "../db/global-db.js";
import { getUserById } from "../db/user-store.js";
import { createSession } from "../db/session-store.js";

export const sessionsRoute = new Hono();

// Deliberately exempt from src/middleware/session-guard.ts (chicken-and-egg: nothing has
// a session id to present until this call returns one). The guard skips this exact path.
sessionsRoute.post("/claim", async (c) => {
  type ClaimBody = { userId?: string; password?: string };
  const body = await c.req.json<ClaimBody>().catch((): ClaimBody => ({}));
  const { userId, password } = body;
  if (!userId || !password) {
    return c.json({ error: "userId and password are required" }, 400);
  }

  const db = getGlobalDb();
  const user = getUserById(db, userId);
  if (!user || !bcrypt.compareSync(password, user.passwordVerifier)) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  const session = createSession(db, user.id);
  return c.json({ sessionId: session.id, claimedAt: session.createdAt });
});
