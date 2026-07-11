const { createRequire } = require("node:module");
const path = require("node:path");
const req = createRequire(path.join("/opt/loremaster", "package.json"));
const Database = req("better-sqlite3");

const storyId = process.argv[2] || "019f25e0-219c-7189-b481-9f389a9a3c39";
const db = new Database(`/opt/loremaster/data/stories/${storyId}.sqlite`, { readonly: true });

function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

const segs = db
  .prepare(
    `SELECT seq, kind, coverage_through_ic_post, coverage_page_id, length(content) as chars, substr(content,1,60) as open
     FROM story_to_date_segment WHERE broken = 0 ORDER BY seq`
  )
  .all();

console.log(`story ${storyId} — ${segs.length} segments`);
let total = 0;
let prevCov = null;
for (const s of segs) {
  const content = db.prepare("SELECT content FROM story_to_date_segment WHERE seq = ? AND broken = 0").get(s.seq)?.content || "";
  const tok = estimateTokens(content);
  total += tok;
  const delta = prevCov != null && s.coverage_through_ic_post != null ? s.coverage_through_ic_post - prevCov : null;
  const gapFlag = delta != null && delta > 1 ? ` *** GAP +${delta} posts ***` : "";
  const page = s.coverage_page_id ? s.coverage_page_id.slice(0, 8) : "?";
  console.log(
    `seq ${String(s.seq).padStart(2)} ${String(s.kind).padEnd(9)} cov ${String(s.coverage_through_ic_post).padStart(4)} (+${delta ?? "?"}) | ${String(tok).padStart(5)} tok | page ${page}${gapFlag}`
  );
  if (s.open) console.log(`     ${s.open.replace(/\s+/g, " ")}...`);
  prevCov = s.coverage_through_ic_post;
}
console.log(`total memory: ~${total} tok (soft cap 6000)`);

// selectFoldSet simulation
const filled = segs
  .map((s) => {
    const content = db.prepare("SELECT content FROM story_to_date_segment WHERE seq = ?").get(s.seq)?.content || "";
    return { seq: s.seq, cov: s.coverage_through_ic_post, tok: estimateTokens(content) };
  })
  .filter((s) => s.tok > 0);

let keepFrom = filled.length - 1;
let kept = filled[keepFrom].tok;
for (let i = filled.length - 2; i >= 0; i--) {
  if (kept + filled[i].tok > 3000) break;
  kept += filled[i].tok;
  keepFrom = i;
}
const foldCount = keepFrom;
const foldTok = filled.slice(0, keepFrom).reduce((a, s) => a + s.tok, 0);
console.log(`\nselectFoldSet: would fold seq 0..${keepFrom - 1} (${foldTok} tok), keep seq ${keepFrom}..${filled.length - 1} (${kept} tok)`);
if (keepFrom > 0 && keepFrom < filled.length) {
  console.log(`  fold span ends cov ${filled[keepFrom - 1].cov}, keep starts cov ${filled[keepFrom].cov} (+${filled[keepFrom].cov - filled[keepFrom - 1].cov} posts)`);
}
