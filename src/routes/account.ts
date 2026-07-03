import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { getGlobalDb } from "../db/global-db.js";
import { DisplayNameTakenError, getUserById, updateDisplayName, updatePassword } from "../db/user-store.js";
import type { AppVariables } from "../middleware/session-guard.js";

export const accountRoute = new Hono<{ Variables: AppVariables }>();

// Every handler below trusts only c.get("userId") (set by sessionGuard from the caller's own
// session), never a userId in the request body — otherwise any authenticated caller could edit
// someone else's account by naming their id in the payload.

accountRoute.get("/", (c) => {
  const db = getGlobalDb();
  const user = getUserById(db, c.get("userId"));
  if (!user) return c.json({ error: "user not found" }, 404);
  return c.json({ id: user.id, displayName: user.displayName });
});

accountRoute.patch("/display-name", async (c) => {
  type Body = { displayName?: string };
  const body = await c.req.json<Body>().catch((): Body => ({}));
  const displayName = body.displayName?.trim();
  if (!displayName) {
    return c.json({ error: "displayName is required" }, 400);
  }

  const db = getGlobalDb();
  try {
    const user = updateDisplayName(db, c.get("userId"), displayName);
    return c.json({ id: user.id, displayName: user.displayName });
  } catch (err) {
    if (err instanceof DisplayNameTakenError) {
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }
});

accountRoute.post("/password", async (c) => {
  type Body = { currentPassword?: string; newPassword?: string };
  const body = await c.req.json<Body>().catch((): Body => ({}));
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) {
    return c.json({ error: "currentPassword and newPassword are required" }, 400);
  }
  if (newPassword.length < 8) {
    return c.json({ error: "newPassword must be at least 8 characters" }, 400);
  }

  const db = getGlobalDb();
  const user = getUserById(db, c.get("userId"));
  if (!user || !bcrypt.compareSync(currentPassword, user.passwordVerifier)) {
    return c.json({ error: "current password is incorrect" }, 401);
  }

  updatePassword(db, user.id, bcrypt.hashSync(newPassword, 10));
  return c.json({ ok: true });
});
