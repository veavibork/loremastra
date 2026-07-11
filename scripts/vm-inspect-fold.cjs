const { createRequire } = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const req = createRequire(path.join("/opt/loremaster", "package.json"));
const Database = req("better-sqlite3");

const prefix = (process.argv[2] || "019f3f1e").toLowerCase();
const dir = "/opt/loremaster/data/stories";

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sqlite") && !f.includes("smoke"))) {
  const dbPath = path.join(dir, file);
  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    db.prepare("SELECT 1 FROM story_to_date_segment LIMIT 1").get();
  } catch {
    if (db) db.close();
    continue;
  }
  const segs = db
    .prepare(
      `SELECT id, seq, kind, coverage_through_ic_post, coverage_page_id, length(content) as chars
       FROM story_to_date_segment WHERE broken = 0 ORDER BY seq`
    )
    .all();
  for (const s of segs) {
    if (
      String(s.id).toLowerCase().startsWith(prefix) ||
      String(s.coverage_page_id || "").toLowerCase().startsWith(prefix)
    ) {
      const content = db.prepare("SELECT content FROM story_to_date_segment WHERE id = ?").get(s.id)?.content || "";
      console.log("---");
      console.log("story:", file.replace(".sqlite", ""));
      console.log("segment:", s.id);
      console.log(`seq ${s.seq} ${s.kind} cov ${s.coverage_through_ic_post} page ${s.coverage_page_id}`);
      console.log(`chars ${s.chars} ~${estimateTokens(content)} tok`);
      console.log("open:", content.replace(/\s+/g, " ").slice(0, 120));
      console.log("close:", content.replace(/\s+/g, " ").slice(-120));
    }
  }
  if (segs.length) {
    let prev = null;
    for (const s of segs) {
      if (!s.content && s.chars === undefined) continue;
      const row = db.prepare("SELECT content FROM story_to_date_segment WHERE id = ?").get(s.id);
      const content = row?.content || "";
      if (!content.trim()) continue;
      const tok = estimateTokens(content);
      const gap = prev && prev.cov != null && s.coverage_through_ic_post != null
        ? s.coverage_through_ic_post - prev.cov
        : null;
      const covGap = prev && prev.cov != null && s.coverage_through_ic_post != null && gap > 1
        ? ` POST-GAP +${gap}`
        : "";
      if (prev && prev.cov != null && s.coverage_through_ic_post != null && s.coverage_through_ic_post <= prev.cov) {
        console.log(`[WARN ${file}] seq ${s.seq} cov ${s.coverage_through_ic_post} does not advance past ${prev.cov}`);
      }
      prev = { seq: s.seq, cov: s.coverage_through_ic_post, tok };
    }
    const total = segs.reduce((sum, s) => {
      const row = db.prepare("SELECT content FROM story_to_date_segment WHERE id = ?").get(s.id);
      return sum + estimateTokens(row?.content || "");
    }, 0);
    const filled = segs.filter((s) => {
      const row = db.prepare("SELECT content FROM story_to_date_segment WHERE id = ?").get(s.id);
      return row?.content?.trim();
    });
    if (filled.length >= 2) {
      const foldable = filled.map((s) => {
        const row = db.prepare("SELECT content FROM story_to_date_segment WHERE id = ?").get(s.id);
        return { seq: s.seq, cov: s.coverage_through_ic_post, tok: estimateTokens(row.content) };
      });
      let keepFrom = foldable.length - 1;
      let kept = foldable[keepFrom].tok;
      for (let i = foldable.length - 2; i >= 0; i--) {
        if (kept + foldable[i].tok > 3000) break;
        kept += foldable[i].tok;
        keepFrom = i;
      }
      const foldEnd = keepFrom > 0 ? foldable[keepFrom - 1] : null;
      const keepStart = foldable[keepFrom];
      if (foldEnd && keepStart && foldEnd.cov != null && keepStart.cov != null) {
        const between = keepStart.cov - foldEnd.cov;
        if (between > 5) {
          console.log(`[FOLD-GAP ${file}] fold ends cov ${foldEnd.cov} (seq ${foldEnd.seq}), keep starts seq ${keepStart.seq} cov ${keepStart.cov} (+${between} posts)`);
        }
      }
    }
  }
  db.close();
}
