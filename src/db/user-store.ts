import type Database from "better-sqlite3";
import { newId } from "../uuid.js";
import { nowIso } from "./time.js";

export interface UserRow {
  id: string;
  createdAt: string;
  displayName: string;
}

/**
 * Pre-auth placeholder: real login/password-derived encryption is deferred
 * (see loremaster.md Security section). Until that's built, everything runs
 * as a single local user so the `users` foreign key stays meaningful without
 * standing up auth early.
 */
export function getOrCreateDefaultUser(db: Database.Database): UserRow {
  const existing = db
    .prepare(`SELECT id, created_at, display_name FROM users ORDER BY created_at ASC LIMIT 1`)
    .get() as { id: string; created_at: string; display_name: string } | undefined;
  if (existing) {
    return { id: existing.id, createdAt: existing.created_at, displayName: existing.display_name };
  }

  const id = newId();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO users (id, created_at, display_name, password_kdf_salt, password_verifier, encrypted_settings, updated_at)
     VALUES (?, ?, ?, '', '', NULL, ?)`
  ).run(id, createdAt, "default", createdAt);
  return { id, createdAt, displayName: "default" };
}
