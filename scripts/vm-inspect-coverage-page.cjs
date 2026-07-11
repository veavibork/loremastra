const { createRequire } = require("node:module");
const path = require("node:path");
const req = createRequire(path.join("/opt/loremaster", "package.json"));
const Database = req("better-sqlite3");

const prefix = (process.argv[2] || "019f2cd7").toLowerCase();
const dir = "/opt/loremaster/data/stories";

function tok(s) {
  return Math.ceil((s || "").length / 4);
}

for (const file of require("node:fs").readdirSync(dir).filter((f) => f.endsWith(".sqlite") && !f.includes("smoke"))) {
  let db;
  try {
    db = new Database(path.join(dir, file), { readonly: true });
    db.prepare("SELECT 1 FROM story_to_date_segment LIMIT 1").get();
  } catch {
    if (db) db.close();
    continue;
  }
  const hit = db
    .prepare(
      `SELECT id, seq, kind, coverage_through_ic_post, coverage_page_id, input_ceiling_ic_post,
              length(content) as chars, content
       FROM story_to_date_segment
       WHERE broken = 0 AND (coverage_page_id LIKE ? OR id LIKE ?)`
    )
    .get(`${prefix}%`, `${prefix}%`);
  if (!hit) {
    db.close();
    continue;
  }
  const prev = db
    .prepare(
      `SELECT seq, coverage_through_ic_post FROM story_to_date_segment
       WHERE broken = 0 AND seq < ? AND content IS NOT NULL AND trim(content) != ''
       ORDER BY seq DESC LIMIT 1`
    )
    .get(hit.seq);
  const next = db
    .prepare(
      `SELECT seq, coverage_through_ic_post, substr(content,1,100) as open
       FROM story_to_date_segment
       WHERE broken = 0 AND seq > ? AND content IS NOT NULL AND trim(content) != ''
       ORDER BY seq LIMIT 1`
    )
    .get(hit.seq);

  console.log("story:", file.replace(".sqlite", ""));
  console.log("segment:", hit.id);
  console.log(`seq ${hit.seq} ${hit.kind}`);
  console.log(`coverage ${hit.coverage_through_ic_post} (ceiling ${hit.input_ceiling_ic_post})`);
  console.log(`prior cov ${prev?.coverage_through_ic_post ?? "?"} (seq ${prev?.seq ?? "?"})`);
  if (prev?.coverage_through_ic_post != null && hit.coverage_through_ic_post != null) {
    console.log(`delta +${hit.coverage_through_ic_post - prev.coverage_through_ic_post} posts`);
  }
  if (next) {
    console.log(`next seq ${next.seq} cov ${next.coverage_through_ic_post}`);
    if (hit.coverage_through_ic_post != null && next.coverage_through_ic_post != null) {
      console.log(`gap to next +${next.coverage_through_ic_post - hit.coverage_through_ic_post} posts`);
    }
    console.log("next open:", (next.open || "").replace(/\s+/g, " "));
  }
  console.log(`size ${hit.chars} chars ~${tok(hit.content)} tok`);
  console.log("--- full ---");
  console.log(hit.content);
  console.log("--- close ---");
  console.log((hit.content || "").replace(/\s+/g, " ").slice(-300));
  db.close();
}
