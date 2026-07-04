import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? ".";
const files = [
  join(root, "data/global.sqlite"),
  ...readdirSync(join(root, "data/stories"))
    .filter((n) => n.endsWith(".sqlite"))
    .map((n) => join(root, "data/stories", n)),
];

for (const file of files) {
  const db = new Database(file);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  console.log("checkpoint", file);
}
