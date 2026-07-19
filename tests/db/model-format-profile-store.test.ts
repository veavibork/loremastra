import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createGlobalDb } from './helpers.js'
import {
  requestModelProbe,
  getModelFormatProfile,
  listModelFormatProfiles,
  claimNextPendingProbe,
  unclaimProbe,
  finishProbe,
  recoverStaleProbes,
  cancelPendingProbe,
} from '../../src/db/model-format-profile-store.js'
import type { ModelFormatProfile } from '../../src/inference/format-probe.js'

let db: Database.Database

beforeEach(() => {
  db = createGlobalDb()
})

const MODEL = 'Qwen/Qwen3-8B'

function fakeProfile(overrides: Partial<ModelFormatProfile> = {}): ModelFormatProfile {
  return {
    provider: 'featherless',
    modelId: MODEL,
    probedAt: '2026-07-19T14:00:00.000Z',
    family: 'qwen',
    reasoningFieldName: 'reasoning',
    inlineThinkingTag: { open: '<think>', close: '</think>' },
    shape: 'separate-field',
    shapeByCondition: { baseline: 'inline-tagged', 'thinking-on': 'separate-field' },
    unmarkedReasoningSuspected: false,
    thinkingOffSuppresses: true,
    thinkingOnProduces: true,
    thinkingBudgetHonored: false,
    leakTokensSeen: [],
    finishReasonReliable: true,
    sane: true,
    saneReasons: [],
    callsAttempted: 8,
    callsSucceeded: 8,
    notes: [],
    ...overrides,
  }
}

describe('requestModelProbe', () => {
  it('creates a pending row for a new model', () => {
    const row = requestModelProbe(db, 'featherless', MODEL, 'user-1')
    expect(row.status).toBe('pending')
    expect(row.profile).toBeNull()
    expect(row.requestedBy).toBe('user-1')
  })

  it('is a no-op while a probe is already pending or running', () => {
    requestModelProbe(db, 'featherless', MODEL, 'user-1')
    const again = requestModelProbe(db, 'featherless', MODEL, 'user-2')
    expect(again.status).toBe('pending')
    expect(again.requestedBy).toBe('user-1')

    claimNextPendingProbe(db)
    const whileRunning = requestModelProbe(db, 'featherless', MODEL, 'user-2')
    expect(whileRunning.status).toBe('running')
  })

  it('re-probe resets a done row to pending but keeps the last profile', () => {
    requestModelProbe(db, 'featherless', MODEL, 'user-1')
    claimNextPendingProbe(db)
    finishProbe(db, 'featherless', MODEL, {
      status: 'done',
      profile: fakeProfile(),
      artifactDir: 'data/experiments/format-probe/x',
    })

    const reprobe = requestModelProbe(db, 'featherless', MODEL, 'user-1')
    expect(reprobe.status).toBe('pending')
    expect(reprobe.profile?.shape).toBe('separate-field')
    expect(reprobe.probedAt).toBe('2026-07-19T14:00:00.000Z')
  })
})

describe('claim/finish lifecycle', () => {
  it('claims the oldest pending probe and marks it running', () => {
    requestModelProbe(db, 'featherless', MODEL, 'user-1')
    const claimed = claimNextPendingProbe(db)
    expect(claimed?.modelId).toBe(MODEL)
    expect(claimed?.status).toBe('running')
    expect(claimNextPendingProbe(db)).toBeNull()
  })

  it('unclaim returns a running probe to pending', () => {
    requestModelProbe(db, 'featherless', MODEL, 'user-1')
    claimNextPendingProbe(db)
    unclaimProbe(db, 'featherless', MODEL)
    expect(getModelFormatProfile(db, 'featherless', MODEL)?.status).toBe('pending')
  })

  it('done stores the profile JSON round-trip', () => {
    requestModelProbe(db, 'featherless', MODEL, 'user-1')
    claimNextPendingProbe(db)
    finishProbe(db, 'featherless', MODEL, {
      status: 'done',
      profile: fakeProfile(),
      artifactDir: null,
    })
    const row = getModelFormatProfile(db, 'featherless', MODEL)
    expect(row?.status).toBe('done')
    expect(row?.profile?.shapeByCondition.baseline).toBe('inline-tagged')
    expect(row?.probedAt).toBe('2026-07-19T14:00:00.000Z')
  })

  it('failure keeps the previous good profile', () => {
    requestModelProbe(db, 'featherless', MODEL, 'user-1')
    claimNextPendingProbe(db)
    finishProbe(db, 'featherless', MODEL, {
      status: 'done',
      profile: fakeProfile(),
      artifactDir: null,
    })
    requestModelProbe(db, 'featherless', MODEL, 'user-1')
    claimNextPendingProbe(db)
    finishProbe(db, 'featherless', MODEL, { status: 'failed', error: 'boom' })

    const row = getModelFormatProfile(db, 'featherless', MODEL)
    expect(row?.status).toBe('failed')
    expect(row?.error).toBe('boom')
    expect(row?.profile?.shape).toBe('separate-field')
  })
})

describe('recovery and cancel', () => {
  it('recoverStaleProbes re-pends running rows', () => {
    requestModelProbe(db, 'featherless', MODEL, 'user-1')
    claimNextPendingProbe(db)
    recoverStaleProbes(db)
    expect(getModelFormatProfile(db, 'featherless', MODEL)?.status).toBe('pending')
  })

  it('cancelPendingProbe cancels only pending rows', () => {
    requestModelProbe(db, 'featherless', MODEL, 'user-1')
    expect(cancelPendingProbe(db, 'featherless', MODEL)).toBe(true)
    expect(getModelFormatProfile(db, 'featherless', MODEL)?.status).toBe('cancelled')

    requestModelProbe(db, 'featherless', MODEL, 'user-1')
    claimNextPendingProbe(db)
    expect(cancelPendingProbe(db, 'featherless', MODEL)).toBe(false)
  })

  it('lists all profiles', () => {
    requestModelProbe(db, 'featherless', MODEL, 'user-1')
    requestModelProbe(db, 'featherless', 'zai-org/GLM-4.7-Flash', 'user-1')
    expect(listModelFormatProfiles(db)).toHaveLength(2)
  })
})
