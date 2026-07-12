#!/usr/bin/env node
/**
 * Broad word-salad / reasoning-crosstalk / "archive"-leak scan across all story DBs.
 * Run on VM: node /tmp/remote-log-skim.mjs
 *
 * Heuristics (all approximate — this is a triage pass to find candidates for manual
 * classification, not a definitive detector):
 *   - archiveLeak: gen_package (prose/setup replies) contains the word "archive" —
 *     very unlikely to appear organically in IC fantasy prose.
 *   - repeatedWord: same word repeated 4+ times consecutively (degenerate-generation tell).
 *   - gibberish: high fraction of long "words" with an implausible vowel ratio (word salad
 *     tends to produce consonant clusters or vowel-only runs that real English doesn't).
 *
 * Reasoning-channel text itself is NOT persisted anywhere (job-events.ts buffer is
 * cleared on job completion) — this scan can only see what landed in the stored reply
 * (text.gen_package), which does cover "reasoning leaked into the answer" (that lands in
 * gen_package) but not "answer leaked into reasoning" (never stored). Note that gap when
 * classifying results.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const ROOT = '/opt/loremaster'
const RECENT_LIMIT = 40

function query(dbPath, sql, params = []) {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

function repeatedWordRun(text) {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? []
  let run = 1
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) {
      run++
      if (run >= 4) return words[i]
    } else {
      run = 1
    }
  }
  return null
}

function gibberishFraction(text) {
  const words = (text.match(/[A-Za-z]{5,}/g) ?? []).filter((w) => w.length >= 5)
  if (words.length < 8) return 0
  let bad = 0
  for (const w of words) {
    const vowels = (w.match(/[aeiouAEIOU]/g) ?? []).length
    const ratio = vowels / w.length
    if (ratio < 0.15 || ratio > 0.85) bad++
  }
  return bad / words.length
}

function classify(text) {
  const flags = []
  if (/\barchive\b/i.test(text)) flags.push('archive-leak')
  const rep = repeatedWordRun(text)
  if (rep) flags.push(`repeated-word:${rep}`)
  const gib = gibberishFraction(text)
  if (gib > 0.15) flags.push(`gibberish:${(gib * 100).toFixed(0)}%`)
  return flags
}

console.log('=== deployed commit ===')
try {
  const { execSync } = await import('node:child_process')
  console.log(execSync('git log -1 --oneline', { cwd: ROOT, encoding: 'utf8' }).trim())
} catch {
  console.log('(git unavailable)')
}

const storyDir = path.join(ROOT, 'data/stories')
const dbFiles = existsSync(storyDir)
  ? readdirSync(storyDir).filter((f) => f.endsWith('.sqlite'))
  : []
console.log(`\n=== scanning ${dbFiles.length} story DB(s) for prose/setup output anomalies ===`)

let totalScanned = 0
let totalFlagged = 0
const flaggedByStory = []

for (const file of dbFiles) {
  const dbPath = path.join(storyDir, file)
  let rows
  try {
    rows = query(
      dbPath,
      `SELECT j.id AS job_id, datetime(j.created_at) AS created, j.job_type, j.model,
              t.gen_package AS text
       FROM jobs j JOIN text t ON t.id = j.target_text_id
       WHERE j.job_type IN ('prose','setup') AND j.status = 'done' AND t.gen_package IS NOT NULL
       ORDER BY j.created_at DESC LIMIT ?`,
      [RECENT_LIMIT],
    )
  } catch (e) {
    console.log(`  (skip ${file}: ${e.message})`)
    continue
  }

  totalScanned += rows.length
  const flagged = []
  for (const r of rows) {
    const flags = classify(r.text)
    if (flags.length) flagged.push({ ...r, flags })
  }
  if (flagged.length) {
    totalFlagged += flagged.length
    flaggedByStory.push({ file, flagged })
  }
}

console.log(
  `scanned ${totalScanned} prose/setup replies across ${dbFiles.length} stories, ${totalFlagged} flagged\n`,
)

for (const { file, flagged } of flaggedByStory) {
  console.log(`--- ${file} (${flagged.length} flagged) ---`)
  for (const r of flagged) {
    console.log(
      `job ${r.job_id} | ${r.created} | ${r.job_type} | ${r.model ?? '—'} | flags: ${r.flags.join(', ')}`,
    )
    console.log(`  text: ${JSON.stringify(r.text.slice(0, 300))}${r.text.length > 300 ? '…' : ''}`)
  }
  console.log()
}

// Full-text manual eyeball dump for the story with the most recent failed
// empty/reasoning-only jobs — heuristics above may be too strict to catch real word salad.
const ACTIVE_STORY_ID = '019f25e0-219c-7189-b481-9f389a9a3c39'
const activeDb = path.join(storyDir, `${ACTIVE_STORY_ID}.sqlite`)
console.log(
  `\n=== full recent prose replies, story ${ACTIVE_STORY_ID} (last 10, no truncation) ===`,
)
if (existsSync(activeDb)) {
  const rows = query(
    activeDb,
    `SELECT j.id AS job_id, datetime(j.created_at) AS created, j.status, j.model, t.gen_package AS text
     FROM jobs j JOIN text t ON t.id = j.target_text_id
     WHERE j.job_type = 'prose' AND t.gen_package IS NOT NULL
     ORDER BY j.created_at DESC LIMIT 10`,
  )
  for (const r of rows) {
    console.log(`--- job ${r.job_id} | ${r.created} | ${r.status} | ${r.model ?? '—'} ---`)
    console.log(r.text)
    console.log()
  }
} else {
  console.log('(missing)')
}

console.log('\n=== all stories: reasoning/empty job errors ===')
for (const file of dbFiles) {
  const dbPath = path.join(storyDir, file)
  const rows = query(
    dbPath,
    `SELECT datetime(created_at) AS created, job_type, status, model, error
     FROM jobs
     WHERE error LIKE '%reasoning%' OR error LIKE '%empty completion%'
     ORDER BY created_at DESC LIMIT 8`,
  )
  if (rows.length) {
    console.log(`--- ${file} (${rows.length} shown) ---`)
    for (const r of rows) console.log(JSON.stringify(r))
  }
}

console.log('\n=== outbound-requests.log ===')
const outbound = path.join(ROOT, 'data/outbound-requests.log')
if (existsSync(outbound)) {
  const lines = readFileSync(outbound, 'utf8').split('\n').filter(Boolean)
  console.log(`lines: ${lines.length}`)
  for (const line of lines.slice(-5)) {
    try {
      const d = JSON.parse(line)
      console.log(`${d.at}\t${d.model}\t${d.call}`)
    } catch {
      console.log(line.slice(0, 120))
    }
  }
} else {
  console.log('(missing)')
}
