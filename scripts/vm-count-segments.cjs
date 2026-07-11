const { createRequire } = require("node:module");
const path = require("node:path");
const req = createRequire(path.join("/opt/loremaster", "package.json"));
const Database = req("better-sqlite3");
const db = new Database("/opt/loremaster/data/stories/019f25e0-219c-7189-b481-9f389a9a3c39.sqlite", { readonly: true });
const n = db.prepare("SELECT count(*) as n FROM story_to_date_segment").get().n;
const filled = db.prepare("SELECT count(*) as n FROM story_to_date_segment WHERE content IS NOT NULL AND trim(content) != ''").get().n;
console.log("segments:", n, "filled:", filled);
