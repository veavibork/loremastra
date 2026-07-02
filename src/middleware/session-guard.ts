import type { Context, Next } from "hono";
import { getGlobalDb } from "../db/global-db.js";
import { getOrCreateDefaultUser } from "../db/user-store.js";
import { getActiveSession, getSession, touchSession } from "../db/session-store.js";

const CLAIM_PATH = "/api/sessions/claim";

/**
 * Global single-active-session enforcement (loremaster.md's Security section — this is
 * the "single-active-session eviction" piece on its own, without the password/login step
 * it originally assumed). Not access control: anyone can still call this API with zero
 * credentials, same as before. It only arbitrates between one trusted user's own
 * devices/tabs, and — per explicit product decision — deliberately covers *all* HTTP
 * access including raw curl/dev scripts, not just the browser, so there's no bypass to
 * remember to use. Direct in-process DB/script access (no HTTP involved) is outside what
 * this can see at all — see docs/stub-revisions.md for that accepted limitation.
 */
export async function sessionGuard(c: Context, next: Next): Promise<Response | void> {
  if (c.req.method === "OPTIONS") return next();
  if (c.req.method === "POST" && c.req.path === CLAIM_PATH) return next();

  const db = getGlobalDb();
  const user = getOrCreateDefaultUser(db);
  const active = getActiveSession(db, user.id);

  if (!active) {
    return c.json({ error: "unclaimed" }, 409);
  }

  const sessionId = c.req.header("X-Loremaster-Session") ?? c.req.query("session");

  if (!sessionId || sessionId !== active.id) {
    const stale = sessionId ? getSession(db, sessionId) : null;
    return c.json(
      {
        error: "superseded",
        active: { lastSeenAt: active.lastSeenAt },
        stale: stale ? { lastSeenAt: stale.lastSeenAt } : null,
      },
      409
    );
  }

  if (c.req.header("X-Loremaster-Interaction") !== "background") {
    touchSession(db, active.id);
  }
  return next();
}
