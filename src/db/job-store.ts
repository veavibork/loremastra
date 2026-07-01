import type Database from "better-sqlite3";
import { newId } from "../uuid.js";
import { nowIso } from "./time.js";

export type JobType = "compress" | "archive" | "continuity" | "prose" | "setup";
export type JobStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface JobRow {
  id: string;
  createdAt: string;
  targetTextId: string | null;
  targetArchiveId: string | null;
  jobType: JobType;
  status: JobStatus;
  priority: number;
  slotCost: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  cancelRequested: boolean;
}

interface RawJobRow {
  id: string;
  created_at: string;
  target_text_id: string | null;
  target_archive_id: string | null;
  job_type: JobType;
  status: JobStatus;
  priority: number;
  slot_cost: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  cancel_requested: number;
}

function mapJobRow(row: RawJobRow): JobRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    targetTextId: row.target_text_id,
    targetArchiveId: row.target_archive_id,
    jobType: row.job_type,
    status: row.status,
    priority: row.priority,
    slotCost: row.slot_cost,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    cancelRequested: !!row.cancel_requested,
  };
}

export function createJob(
  db: Database.Database,
  input: {
    targetTextId?: string;
    targetArchiveId?: string;
    jobType: JobType;
    priority?: number;
    slotCost?: number;
  }
): JobRow {
  if (!input.targetTextId && !input.targetArchiveId) {
    throw new Error("createJob requires either targetTextId or targetArchiveId");
  }
  const id = newId();
  db.prepare(
    `INSERT INTO jobs (id, created_at, target_text_id, target_archive_id, job_type, status, priority, slot_cost, started_at, finished_at, error, cancel_requested)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, 0)`
  ).run(
    id,
    nowIso(),
    input.targetTextId ?? null,
    input.targetArchiveId ?? null,
    input.jobType,
    input.priority ?? 0,
    input.slotCost ?? 1
  );
  return getJob(db, id)!;
}

export function getJob(db: Database.Database, id: string): JobRow | null {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as RawJobRow | undefined;
  return row ? mapJobRow(row) : null;
}

/** On startup, any job still marked 'running' belongs to a process that no longer exists — reset it so it can be claimed again. */
export function recoverStaleJobs(db: Database.Database): void {
  db.prepare(`UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'running'`).run();
}

export function hasActiveJobForText(db: Database.Database, targetTextId: string, jobType: JobType): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM jobs WHERE target_text_id = ? AND job_type = ? AND status IN ('pending', 'running') LIMIT 1`
    )
    .get(targetTextId, jobType);
  return !!row;
}

export function hasActiveJobForArchive(db: Database.Database, targetArchiveId: string, jobType: JobType): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM jobs WHERE target_archive_id = ? AND job_type = ? AND status IN ('pending', 'running') LIMIT 1`
    )
    .get(targetArchiveId, jobType);
  return !!row;
}

/** Most recent jobs regardless of status, for the Debug section's live queue view. */
export function listRecentJobs(db: Database.Database, limit = 30): JobRow[] {
  const rows = db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit) as RawJobRow[];
  return rows.map(mapJobRow);
}

export function listPendingJobs(db: Database.Database): JobRow[] {
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY priority DESC, created_at ASC`)
    .all() as RawJobRow[];
  return rows.map(mapJobRow);
}

/** Atomically claims the next pending job matching jobTypes, or null if none available. */
export function claimNextJob(db: Database.Database, jobTypes: JobType[]): JobRow | null {
  const placeholders = jobTypes.map(() => "?").join(", ");
  const claim = db.transaction((): JobRow | null => {
    const row = db
      .prepare(
        `SELECT * FROM jobs WHERE status = 'pending' AND job_type IN (${placeholders})
         ORDER BY priority DESC, created_at ASC LIMIT 1`
      )
      .get(...jobTypes) as RawJobRow | undefined;
    if (!row) return null;
    db.prepare(`UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?`).run(nowIso(), row.id);
    return getJob(db, row.id);
  });
  return claim();
}

export function finishJob(db: Database.Database, id: string, status: "done" | "failed", error?: string): void {
  db.prepare(`UPDATE jobs SET status = ?, finished_at = ?, error = ? WHERE id = ?`).run(
    status,
    nowIso(),
    error ?? null,
    id
  );
}

/** Marks a job cancelled rather than deleting it — preserves the audit trail like everything else in this schema. */
export function cancelJob(db: Database.Database, id: string): void {
  db.prepare(
    `UPDATE jobs SET status = 'cancelled', finished_at = ?, cancel_requested = 1
     WHERE id = ? AND status IN ('pending', 'running')`
  ).run(nowIso(), id);
}

/** For a running job: signals its executor to abort without changing status yet (executor observes this and finishes the cancel). */
export function requestCancel(db: Database.Database, id: string): void {
  db.prepare(`UPDATE jobs SET cancel_requested = 1 WHERE id = ? AND status = 'running'`).run(id);
}

export function cancelPendingJobsForText(db: Database.Database, targetTextId: string): void {
  db.prepare(
    `UPDATE jobs SET status = 'cancelled', finished_at = ?, cancel_requested = 1
     WHERE target_text_id = ? AND status = 'pending'`
  ).run(nowIso(), targetTextId);
}
