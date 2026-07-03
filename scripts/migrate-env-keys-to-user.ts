/**
 * One-time migration: moves the shared FEATHERLESS_API_KEY/HORDE_API_KEY out of .env and onto
 * a specific user's encrypted DB columns, now that keys are per-user. Run once per deployment
 * (local dev machine, then again on the VM), then remove the two env vars from that
 * environment's .env. Requires APP_MASTER_KEY to already be set in .env.
 *
 * Usage: npx tsx scripts/migrate-env-keys-to-user.ts <userId>
 */
import { getGlobalDb } from "../src/db/global-db.js";
import { getUserById, setFeatherlessKey, setHordeKey } from "../src/db/user-store.js";

function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error("usage: npx tsx scripts/migrate-env-keys-to-user.ts <userId>");
    process.exit(1);
  }

  const db = getGlobalDb();
  const user = getUserById(db, userId);
  if (!user) {
    console.error(`no user found with id ${userId}`);
    process.exit(1);
  }

  const featherlessKey = process.env.FEATHERLESS_API_KEY;
  const hordeKey = process.env.HORDE_API_KEY;
  if (!featherlessKey && !hordeKey) {
    console.error("neither FEATHERLESS_API_KEY nor HORDE_API_KEY is set in .env — nothing to migrate");
    process.exit(1);
  }

  if (featherlessKey) {
    setFeatherlessKey(db, userId, featherlessKey);
    console.log(`migrated Featherless key onto ${user.displayName} (${userId})`);
  }
  if (hordeKey) {
    setHordeKey(db, userId, hordeKey);
    console.log(`migrated Horde key onto ${user.displayName} (${userId})`);
  }
}

main();
