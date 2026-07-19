/**
 * Coverage audit (judge-as-detector) — checks a story-to-date segment against the verbatim
 * posts in its claimed coverage window and flags consequential events the block dropped.
 *
 * Detector ONLY, by explicit product decision from the 2026-07-17 verify-ab experiment
 * (docs/development.md): the judge reliably finds real missing events but is too noisy for
 * unattended gating or auto-rewrite, so it never blocks or modifies anything — it stores a
 * flag on the segment for the Segments tab, and a human decides what to do. The same
 * experiment is where the judge prompt below was calibrated (scripts/story-to-date-verify-ab.ts).
 * Majority vote over AUDIT_VOTES independent runs filters single-run noise.
 */
import type Database from 'better-sqlite3'
import { completeChat, type ChatMessage } from '../../inference/featherless.js'
import type { AgentProfile } from '../../config.js'
import {
  getStoryToDateSegment,
  listStoryToDateSegments,
  setStoryToDateSegmentAudit,
} from '../../db/story-to-date-store.js'
import { buildStoryCorpus, type VerbosePost } from './engine.js'

export const AUDIT_VOTES = 3
export const AUDIT_FAIL_THRESHOLD = 2 // flagged when at least this many votes say fail
/** A window larger than this can't be audited meaningfully in one Editor call (and a fold digest deliberately drops detail — auditing it against verbatim posts would flag everything). */
export const AUDIT_MAX_WINDOW_POSTS = 40
const AUDIT_CALL_TIMEOUT_MS = 5 * 60_000

export interface AuditVote {
  verdict: 'pass' | 'fail'
  missing: string[]
}

export interface AuditResult {
  verdict: 'pass' | 'flagged'
  failVotes: number
  votes: AuditVote[]
  /** Missing-event lines cited by at least AUDIT_FAIL_THRESHOLD votes' worth of failures (union of failing votes, deduped). */
  missing: string[]
}

export function buildAuditJudgeMessages(
  block: string,
  posts: VerbosePost[],
  fromPost: number,
  toPost: number,
): ChatMessage[] {
  const system = `You audit a roleplay memory system. You receive a [STORY CONTINUES] memory block and the verbatim log posts it claims to cover (posts ${fromPost} through ${toPost}). The block's job is to record what future scenes and NPCs must remember from THESE posts.

A consequential event is one a later scene could contradict if it were forgotten: state changes and decisions with consequences; relationship shifts (including new forms of address or pet names); promises and commitments; secrets revealed; injuries, deaths, and standing threats; plans agreed on. Scene staging, color, and blow-by-blow choreography are NOT consequential.

Check each consequential event in the posts against the block. Paraphrase counts as covered — exact wording is not required. Do not penalize compression; penalize absence.

Output EXACTLY this format and nothing else:
[MISSING]
- <one line per consequential event absent from the block, citing the post number — leave the section empty if nothing is missing>
[/MISSING]
[VERDICT]pass[/VERDICT] if nothing consequential is missing, otherwise [VERDICT]fail[/VERDICT]`

  const postsText = posts
    .map((p) => `--- post ${p.icPostNumber} (${p.role}) ---\n${p.content}`)
    .join('\n\n')
  const user = `Memory block to audit:\n\n[STORY CONTINUES]\n${block}\n[/STORY CONTINUES]\n\nPosts ${fromPost}–${toPost} it claims to cover:\n\n${postsText}`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export function parseAuditJudge(raw: string): AuditVote | null {
  const verdictMatch = /\[VERDICT\](pass|fail)\[\/VERDICT\]/i.exec(raw)
  if (!verdictMatch) return null
  const missingMatch = /\[MISSING\]([\s\S]*?)\[\/MISSING\]/i.exec(raw)
  const missing = (missingMatch?.[1] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-') && l.length > 2)
  return { verdict: verdictMatch[1]!.toLowerCase() as 'pass' | 'fail', missing }
}

/** Majority verdict from completed votes, or null if still undecided with votes remaining. */
export function tallyAuditVotes(votes: AuditVote[], totalVotes = AUDIT_VOTES): AuditResult | null {
  const failVotes = votes.filter((v) => v.verdict === 'fail').length
  const remaining = totalVotes - votes.length
  // Early exit as soon as the outcome can't change (e.g. first two votes agree).
  if (failVotes < AUDIT_FAIL_THRESHOLD && failVotes + remaining >= AUDIT_FAIL_THRESHOLD) return null
  const verdict = failVotes >= AUDIT_FAIL_THRESHOLD ? 'flagged' : 'pass'
  const missing =
    verdict === 'flagged'
      ? [...new Set(votes.filter((v) => v.verdict === 'fail').flatMap((v) => v.missing))]
      : []
  return { verdict, failVotes, votes, missing }
}

/**
 * Runs the full audit for one segment and stores the result on the segment row.
 * Votes run sequentially — each is a full Editor call, and the job already holds
 * one Editor-cost slot; parallel votes would burst past the account limit.
 */
export async function executeSegmentAudit(
  db: Database.Database,
  editor: AgentProfile,
  apiKey: string,
  storyId: string,
  logbookId: string,
  segmentId: string,
  options?: { signal?: AbortSignal; onVote?: (voteNumber: number) => void },
): Promise<AuditResult> {
  const segment = getStoryToDateSegment(db, segmentId)
  if (!segment?.content?.trim() || segment.broken) {
    throw new Error('segment has no content to audit')
  }
  if (segment.coverageThroughIcPost == null) {
    throw new Error('segment has no coverage to audit against')
  }

  // The window starts after the previous ready segment's coverage (audit-worthy segments are
  // 'continues' blocks; a 'begins' block starts at post 1).
  const prior = listStoryToDateSegments(db, logbookId)
    .filter(
      (s) =>
        s.seq < segment.seq && s.content?.trim() && !s.broken && s.coverageThroughIcPost != null,
    )
    .sort((a, b) => b.seq - a.seq)[0]
  const fromPost = (prior?.coverageThroughIcPost ?? 0) + 1
  const toPost = segment.coverageThroughIcPost

  const windowPosts = toPost - fromPost + 1
  if (windowPosts < 1) throw new Error(`empty audit window (posts ${fromPost}–${toPost})`)
  if (windowPosts > AUDIT_MAX_WINDOW_POSTS) {
    throw new Error(
      `coverage window too large to audit (${windowPosts} posts > ${AUDIT_MAX_WINDOW_POSTS}) — deep-past digests drop detail by design`,
    )
  }

  const corpus = buildStoryCorpus(db, storyId, logbookId, {
    contextLimit: editor.contextLimit,
    responseLimit: editor.responseLimit,
    afterPageId: prior?.coveragePageId ?? undefined,
    throughPost: toPost,
  })
  const posts = corpus.includedPosts.filter(
    (p) => p.icPostNumber >= fromPost && p.icPostNumber <= toPost,
  )
  if (!posts.length) throw new Error(`no posts found in audit window (${fromPost}–${toPost})`)

  const messages = buildAuditJudgeMessages(segment.content.trim(), posts, fromPost, toPost)
  const votes: AuditVote[] = []
  let result: AuditResult | null = null
  for (let i = 1; i <= AUDIT_VOTES && !result; i++) {
    options?.onVote?.(i)
    const raw = await completeChat(editor, apiKey, messages, {
      maxTokens: editor.responseLimit,
      timeoutMs: AUDIT_CALL_TIMEOUT_MS,
      signal: options?.signal,
    })
    const vote = parseAuditJudge(raw)
    if (!vote)
      throw new Error(`audit vote ${i} returned unparseable output: "${raw.slice(0, 120)}"`)
    votes.push(vote)
    result = tallyAuditVotes(votes)
  }
  if (!result) result = tallyAuditVotes(votes, votes.length)!

  setStoryToDateSegmentAudit(db, segmentId, { verdict: result.verdict, missing: result.missing })
  return result
}
