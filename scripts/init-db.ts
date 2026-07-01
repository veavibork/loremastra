import { getGlobalDb } from "../src/db/global-db.js";
import { getStoryDb } from "../src/db/story-db.js";
import { newId } from "../src/uuid.js";

function listTables(db: import("better-sqlite3").Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

const globalDb = getGlobalDb();
console.log("Global DB tables:", listTables(globalDb));

const smokeTestStoryId = newId();
const storyDb = getStoryDb(smokeTestStoryId);
console.log(`Story DB (${smokeTestStoryId}) tables:`, listTables(storyDb));
