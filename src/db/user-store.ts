import type Database from "better-sqlite3";
import { newId } from "../uuid.js";
import { nowIso } from "./time.js";

export interface UserRow {
  id: string;
  createdAt: string;
  displayName: string;
}

export interface UserAuthRow extends UserRow {
  passwordVerifier: string;
}

export function createUser(db: Database.Database, displayName: string, passwordHash: string): UserRow {
  const id = newId();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO users (id, created_at, display_name, password_kdf_salt, password_verifier, encrypted_settings, updated_at)
     VALUES (?, ?, ?, '', ?, NULL, ?)`
  ).run(id, createdAt, displayName, passwordHash, createdAt);
  return { id, createdAt, displayName };
}

/** id + display_name only — safe to expose to an unauthenticated profile picker. */
export function listUsers(db: Database.Database): UserRow[] {
  const rows = db
    .prepare(`SELECT id, created_at, display_name FROM users ORDER BY created_at ASC`)
    .all() as { id: string; created_at: string; display_name: string }[];
  return rows.map((row) => ({ id: row.id, createdAt: row.created_at, displayName: row.display_name }));
}

export function getUserById(db: Database.Database, id: string): UserAuthRow | null {
  const row = db
    .prepare(`SELECT id, created_at, display_name, password_verifier FROM users WHERE id = ?`)
    .get(id) as { id: string; created_at: string; display_name: string; password_verifier: string } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    displayName: row.display_name,
    passwordVerifier: row.password_verifier,
  };
}
