import type Database from 'better-sqlite3'
import { newId } from '../lib/uuid.js'
import { nowIso } from '../lib/time.js'

export type JobType =
  | 'continuity'
  | 'prose'
  | 'setup'
  | 'setup-worldbook'
  | 'tag-gen'
  | 'story-name'
  | 'segment-name'
  | 'story-to-date'
  | 'story-to-date-fold'
  | 'worldbook-compact'
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface JobRow {
  id: string
  createdAt: string
  targetTextId: string | null
  targetStoryToDateId: string | null
  jobType: JobType
  status: JobStatus
  priority: number
  slotCost: number
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  cancelRequested: boolean
  model: string | null
  tokenEstimate: number | null
  inputTokenEstimate: number | null
  hordeRequestId: string | null
  elapsedMs: number | null
  resultSummary: string | null
}

interface RawJobRow {
  id: string
  created_at: string
  target_text_id: string | null
  target_story_to_date_id: string | null
  job_type: JobType
  status: JobStatus
  priority: number
  slot_cost: number
  started_at: string | null
  finished_at: string | null
  error: string | null
  cancel_requested: number
  model: string | null
  token_estimate: number | null
  input_token_estimate: number | null
  horde_request_id: string | null
  elapsed_ms: number | null
  result_summary: string | null
}

function mapJobRow(row: RawJobRow): JobRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    targetTextId: row.target_text_id,
    targetStoryToDateId: row.target_story_to_date_id ?? null,
    jobType: row.job_type,
    status: row.status,
    priority: row.priority,
    slotCost: row.slot_cost,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    cancelRequested: !!row.cancel_requested,
    model: row.model,
    tokenEstimate: row.token_estimate,
    inputTokenEstimate: row.input_token_estimate ?? null,
    hordeRequestId: row.horde_request_id,
    elapsedMs: row.elapsed_ms ?? null,
    resultSummary: row.result_summary ?? null,
  }
}

export function createJob(
  db: Database.Database,
  input: {
    targetTextId?: string
    targetStoryToDateId?: string
    jobType: JobType
    priority?: number
    slotCost?: number
  },
): JobRow {
  const targets = [input.targetTextId, input.targetStoryToDateId].filter(Boolean)
  if (targets.length !== 1) {
    throw new Error('createJob requires exactly one of targetTextId or targetStoryToDateId')
  }
  const id = newId()
  db.prepare(
    `INSERT INTO jobs (id, created_at, target_text_id, target_story_to_date_id, job_type, status, priority, slot_cost, started_at, finished_at, error, cancel_requested)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, 0)`,
  ).run(
    id,
    nowIso(),
    input.targetTextId ?? null,
    input.targetStoryToDateId ?? null,
    input.jobType,
    input.priority ?? 0,
    input.slotCost ?? 1,
  )
  return getJob(db, id)!
}

export function getJob(db: Database.Database, id: string): JobRow | null {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as RawJobRow | undefined
  return row ? mapJobRow(row) : null
}

/**
 * On startup, any job still marked 'running' belongs to a process that no longer exists —
 * reset it so it can be claimed again. Excludes Horde jobs with a recorded request id: unlike
 * a Featherless stream (which genuinely dies with the process), a submitted Horde job may
 * still be processing server-side — resetting it to pending would cause scanStory to reclaim
 * and resubmit it as a brand-new request, orphaning the original. Those rows stay 'running'
 * for listRunningHordeJobs' poll loop to pick back up by request id instead.
 */
export function recoverStaleJobs(db: Database.Database): void {
  db.prepare(
    `UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'running' AND horde_request_id IS NULL`,
  ).run()
}

export function setHordeRequestId(db: Database.Database, jobId: string, requestId: string): void {
  db.prepare(`UPDATE jobs SET horde_request_id = ? WHERE id = ?`).run(requestId, jobId)
}

/**
 * Records which model actually received the submission, at submit time — needed because
 * resolveHordeJob runs on a later scan tick, by which point getAgentProfile("author") may
 * point at a different row entirely (the user reordered/edited configs while the job was
 * in flight). Reading job.model back at resolution time instead of re-querying the live
 * profile is what keeps a Horde completion from being mislabeled with whatever config
 * happens to be primary by the time it finishes.
 */
export function setJobModel(db: Database.Database, jobId: string, model: string): void {
  db.prepare(`UPDATE jobs SET model = ? WHERE id = ?`).run(model, jobId)
}

/** Prompt size at inference start — used for prefill countdown labels in the story UI. */
export function setJobInputTokenEstimate(
  db: Database.Database,
  jobId: string,
  inputTokenEstimate: number,
): void {
  db.prepare(`UPDATE jobs SET input_token_estimate = ? WHERE id = ?`).run(inputTokenEstimate, jobId)
}

/** Jobs submitted to Horde and still awaiting resolution — the "come back later and check on this" query the scan loop's Horde poll uses, since claimNextJob only ever looks at 'pending' rows. */
export function listRunningHordeJobs(db: Database.Database): JobRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE status = 'running' AND horde_request_id IS NOT NULL ORDER BY created_at ASC`,
    )
    .all() as RawJobRow[]
  return rows.map(mapJobRow)
}

export function hasActiveJobForText(
  db: Database.Database,
  targetTextId: string,
  jobType: JobType,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM jobs WHERE target_text_id = ? AND job_type = ? AND status IN ('pending', 'running') LIMIT 1`,
    )
    .get(targetTextId, jobType)
  return !!row
}

export function hasActiveWorldbookCompactJob(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM jobs WHERE job_type = 'worldbook-compact' AND status IN ('pending', 'running') LIMIT 1`,
    )
    .get()
  return !!row
}

export function hasActiveJobForStoryToDate(
  db: Database.Database,
  targetStoryToDateId: string,
  jobType: JobType = 'story-to-date',
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM jobs WHERE target_story_to_date_id = ? AND job_type = ? AND status IN ('pending', 'running') LIMIT 1`,
    )
    .get(targetStoryToDateId, jobType)
  return !!row
}

export function cancelPendingJobsForStoryToDate(
  db: Database.Database,
  targetStoryToDateId: string,
): void {
  db.prepare(
    `UPDATE jobs SET status = 'cancelled', finished_at = ?, cancel_requested = 1, error = COALESCE(error, ?)
     WHERE target_story_to_date_id = ? AND status IN ('pending', 'running')`,
  ).run(nowIso(), 'segment removed', targetStoryToDateId)
  db.prepare(
    `UPDATE jobs SET target_story_to_date_id = NULL WHERE target_story_to_date_id = ?`,
  ).run(targetStoryToDateId)
}

/** Most recent jobs regardless of status, for the Debug section's live queue view. */
export function listRecentJobs(db: Database.Database, limit = 30): JobRow[] {
  const rows = db
    .prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as RawJobRow[]
  return rows.map(mapJobRow)
}

/** Jobs not yet resolved (queued or actively generating), for clients reattaching to an in-flight generation after a remount. */
export function listActiveJobs(db: Database.Database): JobRow[] {
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE status IN ('pending', 'running') ORDER BY created_at ASC`)
    .all() as RawJobRow[]
  return rows.map(mapJobRow)
}

export function listPendingJobs(db: Database.Database): JobRow[] {
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY priority DESC, created_at ASC`)
    .all() as RawJobRow[]
  return rows.map(mapJobRow)
}

/** Atomically claims the next pending job matching jobTypes, or null if none available. */
export function claimNextJob(db: Database.Database, jobTypes: JobType[]): JobRow | null {
  const placeholders = jobTypes.map(() => '?').join(', ')
  const claim = db.transaction((): JobRow | null => {
    const row = db
      .prepare(
        `SELECT * FROM jobs WHERE status = 'pending' AND job_type IN (${placeholders})
         ORDER BY priority DESC, created_at ASC LIMIT 1`,
      )
      .get(...jobTypes) as RawJobRow | undefined
    if (!row) return null
    db.prepare(`UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?`).run(
      nowIso(),
      row.id,
    )
    return getJob(db, row.id)
  })
  return claim()
}

export function finishJob(
  db: Database.Database,
  id: string,
  status: 'done' | 'failed',
  error?: string,
  meta?: { model?: string; tokenEstimate?: number; elapsedMs?: number; resultSummary?: string },
): void {
  db.prepare(
    `UPDATE jobs SET status = ?, finished_at = ?, error = ?, model = COALESCE(?, model), token_estimate = COALESCE(?, token_estimate), elapsed_ms = COALESCE(?, elapsed_ms), result_summary = COALESCE(?, result_summary) WHERE id = ?`,
  ).run(
    status,
    nowIso(),
    error ?? null,
    meta?.model ?? null,
    meta?.tokenEstimate ?? null,
    meta?.elapsedMs ?? null,
    meta?.resultSummary ?? null,
    id,
  )
}

/** Marks a job cancelled rather than deleting it — preserves the audit trail like everything else in this schema. */
export function cancelJob(db: Database.Database, id: string): void {
  db.prepare(
    `UPDATE jobs SET status = 'cancelled', finished_at = ?, cancel_requested = 1
     WHERE id = ? AND status IN ('pending', 'running')`,
  ).run(nowIso(), id)
}

/** For a running job: signals its executor to abort without changing status yet (executor observes this and finishes the cancel). */
export function requestCancel(db: Database.Database, id: string): void {
  db.prepare(`UPDATE jobs SET cancel_requested = 1 WHERE id = ? AND status = 'running'`).run(id)
}

export function cancelPendingJobsForText(db: Database.Database, targetTextId: string): void {
  db.prepare(
    `UPDATE jobs SET status = 'cancelled', finished_at = ?, cancel_requested = 1
     WHERE target_text_id = ? AND status = 'pending'`,
  ).run(nowIso(), targetTextId)
}
