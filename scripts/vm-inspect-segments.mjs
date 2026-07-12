#!/usr/bin/env node
/** One-off VM inspection: story-to-date segment coverage and overlap signals. */
import Database from 'better-sqlite3'

const storyId = process.argv[2] ?? '019f25e0-219c-7189-b481-9f389a9a3c39'
const dbPath = process.argv[3] ?? `/opt/loremaster/data/stories/${storyId}.sqlite`
const focus = (process.argv[4] ?? '28-40').split(',').flatMap((r) => {
  const [a, b] = r.split('-').map(Number)
  if (b) {
    const out = []
    for (let i = a; i <= b; i++) out.push(i)
    return out
  }
  return [a]
})

const db = new Database(dbPath, { readonly: true })
const rows = db
  .prepare(
    `SELECT seq, kind, coverage_through_ic_post, length(content) as chars, content
     FROM story_to_date_segment WHERE broken = 0 ORDER BY seq`,
  )
  .all()

console.log(`DB: ${dbPath}`)
console.log(`Segments: ${rows.length}`)
console.log('--- coverage ---')
for (const r of rows) {
  const prev = rows.find((x) => x.seq === r.seq - 1)
  const delta =
    prev?.coverage_through_ic_post != null && r.coverage_through_ic_post != null
      ? r.coverage_through_ic_post - prev.coverage_through_ic_post
      : null
  console.log(
    `seq ${String(r.seq).padStart(2)} | ${r.kind.padEnd(9)} | cov ${r.coverage_through_ic_post ?? '?'} | +${delta ?? '?'} posts | ${r.chars} chars`,
  )
}

function words(s) {
  return s.trim().split(/\s+/).filter(Boolean)
}

function overlapRatio(a, b) {
  const aw = words(a)
  const bw = words(b)
  const setB = new Set(bw.map((w) => w.toLowerCase()))
  const shared = aw.filter((w) => setB.has(w.toLowerCase())).length
  return aw.length ? shared / aw.length : 0
}

function hasMarkerLeak(text) {
  return /\[STORY (?:BEGINS|CONTINUES|TO DATE)\]/i.test(text)
}

console.log('\n--- focus seqs ---')
for (const seq of focus) {
  const r = rows.find((x) => x.seq === seq)
  if (!r) {
    console.log(`seq ${seq}: (missing)`)
    continue
  }
  const prev = rows.find((x) => x.seq === seq - 1)
  const preview = r.content.replace(/\s+/g, ' ').slice(0, 200)
  const leak = hasMarkerLeak(r.content)
  const overlap = prev ? overlapRatio(r.content, prev.content) : null
  console.log(`\n=== seq ${seq} (cov ${r.coverage_through_ic_post}) ===`)
  if (leak) console.log('  MARKER LEAK: yes')
  if (overlap != null)
    console.log(`  word overlap with seq ${seq - 1}: ${(overlap * 100).toFixed(1)}%`)
  console.log(`  open: ${preview}...`)
  const close = r.content.replace(/\s+/g, ' ').slice(-200)
  console.log(`  close: ...${close}`)
}
