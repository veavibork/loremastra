import type Database from 'better-sqlite3'
import { nowIso } from '../lib/time.js'
import type { ModelFormatProfile } from '../inference/format-probe.js'

export type ProbeStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface ModelFormatProfileRow {
  provider: string
  modelId: string
  requestedBy: string
  status: ProbeStatus
  /** Last successfully probed profile — survives a re-probe until the new one lands. */
  profile: ModelFormatProfile | null
  probedAt: string | null
  artifactDir: string | null
  error: string | null
  /** Runtime tripwire: when a live stream first contradicted this profile. Cleared by the next successful probe. */
  driftDetectedAt: string | null
  driftReasons: string[]
  createdAt: string
  updatedAt: string
}

interface RawRow {
  provider: string
  model_id: string
  requested_by: string
  status: ProbeStatus
  profile_json: string | null
  probed_at: string | null
  artifact_dir: string | null
  error: string | null
  drift_detected_at: string | null
  drift_reasons: string | null
  created_at: string
  updated_at: string
}

function mapRow(row: RawRow): ModelFormatProfileRow {
  let profile: ModelFormatProfile | null = null
  if (row.profile_json) {
    try {
      profile = JSON.parse(row.profile_json) as ModelFormatProfile
    } catch {
      profile = null
    }
  }
  let driftReasons: string[] = []
  if (row.drift_reasons) {
    try {
      const parsed = JSON.parse(row.drift_reasons) as unknown
      if (Array.isArray(parsed)) driftReasons = parsed.filter((r) => typeof r === 'string')
    } catch {
      /* malformed — treated as no recorded reasons */
    }
  }
  return {
    provider: row.provider,
    modelId: row.model_id,
    requestedBy: row.requested_by,
    status: row.status,
    profile,
    probedAt: row.probed_at,
    artifactDir: row.artifact_dir,
    error: row.error,
    driftDetectedAt: row.drift_detected_at,
    driftReasons,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getModelFormatProfile(
  db: Database.Database,
  provider: string,
  modelId: string,
): ModelFormatProfileRow | null {
  const row = db
    .prepare(`SELECT * FROM model_format_profiles WHERE provider = ? AND model_id = ?`)
    .get(provider, modelId) as RawRow | undefined
  return row ? mapRow(row) : null
}

export function listModelFormatProfiles(db: Database.Database): ModelFormatProfileRow[] {
  const rows = db
    .prepare(`SELECT * FROM model_format_profiles ORDER BY updated_at DESC`)
    .all() as RawRow[]
  return rows.map(mapRow)
}

/**
 * Enqueue a probe: inserts a pending row, or resets an existing row to pending (a re-probe).
 * The last good profile_json is deliberately kept — consumers read stale-but-real data while
 * the re-probe runs. No-op if a probe is already pending or running for this model.
 */
export function requestModelProbe(
  db: Database.Database,
  provider: string,
  modelId: string,
  requestedBy: string,
): ModelFormatProfileRow {
  const now = nowIso()
  const existing = getModelFormatProfile(db, provider, modelId)
  if (!existing) {
    db.prepare(
      `INSERT INTO model_format_profiles (provider, model_id, requested_by, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    ).run(provider, modelId, requestedBy, now, now)
  } else if (existing.status !== 'pending' && existing.status !== 'running') {
    db.prepare(
      `UPDATE model_format_profiles SET status = 'pending', requested_by = ?, error = NULL, updated_at = ?
       WHERE provider = ? AND model_id = ?`,
    ).run(requestedBy, now, provider, modelId)
  }
  return getModelFormatProfile(db, provider, modelId)!
}

/** Atomically claims the oldest pending probe (pending → running), or null if none. */
export function claimNextPendingProbe(db: Database.Database): ModelFormatProfileRow | null {
  const claim = db.transaction((): ModelFormatProfileRow | null => {
    const row = db
      .prepare(
        `SELECT * FROM model_format_profiles WHERE status = 'pending' ORDER BY updated_at ASC LIMIT 1`,
      )
      .get() as RawRow | undefined
    if (!row) return null
    db.prepare(
      `UPDATE model_format_profiles SET status = 'running', updated_at = ? WHERE provider = ? AND model_id = ?`,
    ).run(nowIso(), row.provider, row.model_id)
    return getModelFormatProfile(db, row.provider, row.model_id)
  })
  return claim()
}

/** Puts a claimed-but-not-started probe back (e.g. no free concurrency slot this tick). */
export function unclaimProbe(db: Database.Database, provider: string, modelId: string): void {
  db.prepare(
    `UPDATE model_format_profiles SET status = 'pending' WHERE provider = ? AND model_id = ? AND status = 'running'`,
  ).run(provider, modelId)
}

export function finishProbe(
  db: Database.Database,
  provider: string,
  modelId: string,
  outcome:
    | { status: 'done'; profile: ModelFormatProfile; artifactDir: string | null }
    | { status: 'failed' | 'cancelled'; error: string },
): void {
  const now = nowIso()
  if (outcome.status === 'done') {
    // A fresh profile supersedes any recorded drift — the re-probe is the drift's resolution.
    db.prepare(
      `UPDATE model_format_profiles SET status = 'done', profile_json = ?, probed_at = ?, artifact_dir = ?, error = NULL,
         drift_detected_at = NULL, drift_reasons = NULL, updated_at = ?
       WHERE provider = ? AND model_id = ?`,
    ).run(
      JSON.stringify(outcome.profile),
      outcome.profile.probedAt,
      outcome.artifactDir,
      now,
      provider,
      modelId,
    )
  } else {
    // Failure/cancel keeps the previous profile_json/probed_at — stale truth beats no truth.
    db.prepare(
      `UPDATE model_format_profiles SET status = ?, error = ?, updated_at = ?
       WHERE provider = ? AND model_id = ?`,
    ).run(outcome.status, outcome.error, now, provider, modelId)
  }
}

/**
 * Startup recovery: a row still 'running' belongs to a process that no longer exists —
 * re-pend it so the runner picks it back up (same contract as job-store's recoverStaleJobs;
 * probes have no Horde-style server-side continuation to preserve).
 */
export function recoverStaleProbes(db: Database.Database): void {
  db.prepare(`UPDATE model_format_profiles SET status = 'pending' WHERE status = 'running'`).run()
}

/**
 * Runtime tripwire write (plan step 6): first detection wins — an already-flagged model keeps
 * its original evidence until a successful probe clears it, so a drifting model doesn't
 * rewrite this row on every subsequent generation.
 */
export function recordFormatDrift(
  db: Database.Database,
  provider: string,
  modelId: string,
  reasons: string[],
): boolean {
  const result = db
    .prepare(
      `UPDATE model_format_profiles SET drift_detected_at = ?, drift_reasons = ?, updated_at = ?
       WHERE provider = ? AND model_id = ? AND drift_detected_at IS NULL`,
    )
    .run(nowIso(), JSON.stringify(reasons.slice(0, 10)), nowIso(), provider, modelId)
  return result.changes > 0
}

/** Cancel a pending probe directly (a running one must be aborted via the runner instead). */
export function cancelPendingProbe(
  db: Database.Database,
  provider: string,
  modelId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE model_format_profiles SET status = 'cancelled', error = 'cancelled before start', updated_at = ?
       WHERE provider = ? AND model_id = ? AND status = 'pending'`,
    )
    .run(nowIso(), provider, modelId)
  return result.changes > 0
}
