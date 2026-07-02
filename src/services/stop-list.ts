import { getGlobalDb } from "../db/global-db.js";
import { getOrCreateDefaultUser } from "../db/user-store.js";
import { listBannedPhrases } from "../db/banned-phrase-store.js";

/**
 * Plain-string `stop` list only — see docs/featherless-notes.md's `/v1/tokenize` note for why
 * `stop_token_ids` isn't populated: Featherless's real tokenize response has no token array to
 * build one from, despite what the (now-corrected) docs said.
 */
export function getStopPhrases(): string[] {
  const db = getGlobalDb();
  const user = getOrCreateDefaultUser(db);
  return listBannedPhrases(db, user.id).map((p) => p.phrase);
}
