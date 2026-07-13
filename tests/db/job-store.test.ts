import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createStoryDb } from './helpers.js'
import {
  createJob,
  getJob,
  claimNextJob,
  finishJob,
  hasActiveJobForText,
  listRecentJobs,
  listActiveJobs,
  listPendingJobs,
} from '../../src/db/job-store.js'

let db: Database.Database

beforeEach(() => {
  db = createStoryDb()
})

describe('createJob', () => {
  it('creates a pending job with defaults', () => {
    const job = createJob(db, { targetTextId: 't1', jobType: 'prose' })
    expect(job.id).toBeTruthy()
    expect(job.status).toBe('pending')
    expect(job.jobType).toBe('prose')
    expect(job.priority).toBe(0)
    expect(job.slotCost).toBe(1)
    expect(job.targetTextId).toBe('t1')
  })

  it('accepts priority and slotCost', () => {
    const job = createJob(db, { targetTextId: 't2', jobType: 'prose', priority: 5, slotCost: 4 })
    expect(job.priority).toBe(5)
    expect(job.slotCost).toBe(4)
  })

  it('throws when no target is specified', () => {
    expect(() => createJob(db, { jobType: 'prose' })).toThrow('exactly one')
  })

  it('throws when multiple targets specified', () => {
    expect(() =>
      createJob(db, { targetTextId: 't3', targetStoryToDateId: 's1', jobType: 'prose' }),
    ).toThrow('exactly one')
  })

  it('round-trips through getJob', () => {
    const created = createJob(db, { targetTextId: 't4', jobType: 'setup' })
    const found = getJob(db, created.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
    expect(found!.jobType).toBe('setup')
  })
})

describe('getJob', () => {
  it('returns null for unknown id', () => {
    expect(getJob(db, 'nonexistent')).toBeNull()
  })
})

describe('claimNextJob', () => {
  it('claims the highest-priority pending job', () => {
    createJob(db, { targetTextId: 'l1', jobType: 'prose', priority: 0 })
    createJob(db, { targetTextId: 'l2', jobType: 'prose', priority: 10 })
    createJob(db, { targetTextId: 'l3', jobType: 'setup', priority: 5 })

    const claimed = claimNextJob(db, ['prose'])
    expect(claimed).not.toBeNull()
    expect(claimed!.targetTextId).toBe('l2') // priority 10
    expect(claimed!.status).toBe('running')
  })

  it('returns null when no matching job type', () => {
    expect(claimNextJob(db, ['story-name'])).toBeNull()
  })

  it('atomically updates status to running', () => {
    createJob(db, { targetTextId: 'atomic', jobType: 'prose' })
    const claimed = claimNextJob(db, ['prose'])
    expect(claimed).not.toBeNull()
    const reFetched = getJob(db, claimed!.id)
    expect(reFetched!.status).toBe('running')
    expect(reFetched!.startedAt).toBeTruthy()
  })
})

describe('finishJob', () => {
  it('marks a job as done', () => {
    const job = createJob(db, { targetTextId: 'f1', jobType: 'prose' })
    finishJob(db, job.id, 'done')
    const updated = getJob(db, job.id)!
    expect(updated.status).toBe('done')
    expect(updated.finishedAt).toBeTruthy()
  })

  it('marks a job as failed with error', () => {
    const job = createJob(db, { targetTextId: 'f2', jobType: 'prose' })
    finishJob(db, job.id, 'failed', 'something broke')
    const updated = getJob(db, job.id)!
    expect(updated.status).toBe('failed')
    expect(updated.error).toBe('something broke')
  })

  it('records metadata', () => {
    const job = createJob(db, { targetTextId: 'f3', jobType: 'prose' })
    finishJob(db, job.id, 'done', undefined, {
      model: 'test-model',
      tokenEstimate: 42,
      elapsedMs: 150,
    })
    const updated = getJob(db, job.id)!
    expect(updated.model).toBe('test-model')
    expect(updated.tokenEstimate).toBe(42)
    expect(updated.elapsedMs).toBe(150)
  })
})

describe('hasActiveJobForText', () => {
  it('returns true when pending job exists', () => {
    createJob(db, { targetTextId: 'active-t1', jobType: 'prose' })
    expect(hasActiveJobForText(db, 'active-t1', 'prose')).toBe(true)
  })

  it('returns false for finished jobs', () => {
    const job = createJob(db, { targetTextId: 'active-t2', jobType: 'prose' })
    finishJob(db, job.id, 'done')
    expect(hasActiveJobForText(db, 'active-t2', 'prose')).toBe(false)
  })

  it('returns false for unknown target', () => {
    expect(hasActiveJobForText(db, 'nonexistent', 'prose')).toBe(false)
  })
})

describe('listRecentJobs', () => {
  it('returns the most recently created jobs', () => {
    createJob(db, { targetTextId: 'r1', jobType: 'prose' })
    createJob(db, { targetTextId: 'r2', jobType: 'prose' })
    const recent = listRecentJobs(db, 5)
    expect(recent.length).toBeGreaterThanOrEqual(2)
    // Both jobs were created; ordering is newest-first when timestamps differ.
    const ids = recent.map((j) => j.targetTextId)
    expect(ids).toContain('r1')
    expect(ids).toContain('r2')
  })
})

describe('listActiveJobs', () => {
  it('returns only pending and running jobs', () => {
    createJob(db, { targetTextId: 'a1', jobType: 'prose' })
    const done = createJob(db, { targetTextId: 'a2', jobType: 'prose' })
    finishJob(db, done.id, 'done')
    const active = listActiveJobs(db)
    expect(active).toHaveLength(1)
    expect(active[0]!.targetTextId).toBe('a1')
  })
})

describe('listPendingJobs', () => {
  it('returns only pending jobs in priority order', () => {
    createJob(db, { targetTextId: 'p1', jobType: 'prose', priority: 1 })
    createJob(db, { targetTextId: 'p2', jobType: 'prose', priority: 10 })
    const pending = listPendingJobs(db)
    expect(pending.length).toBeGreaterThanOrEqual(2)
    expect(pending[0]!.priority).toBeGreaterThanOrEqual(pending[1]!.priority)
  })
})
