import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createStoryDb } from './helpers.js'
import {
  getStoryState,
  setStoryPhase,
  setKickoffPageId,
  setCurrentPageId,
  getHistoryCursorSeq,
  setHistoryCursorSeq,
} from '../../src/db/story-state-store.js'

let db: Database.Database

beforeEach(() => {
  db = createStoryDb()
})

describe('getStoryState', () => {
  it('returns default state on fresh DB', () => {
    const state = getStoryState(db)
    expect(state.phase).toBe('setup')
    expect(state.kickoffPageId).toBeNull()
    expect(state.currentPageId).toBeNull()
  })
})

describe('setStoryPhase', () => {
  it('transitions through phases', () => {
    setStoryPhase(db, 'kickoff')
    expect(getStoryState(db).phase).toBe('kickoff')
    setStoryPhase(db, 'story')
    expect(getStoryState(db).phase).toBe('story')
  })
})

describe('setKickoffPageId', () => {
  it('sets and clears the kickoff page', () => {
    setKickoffPageId(db, 'page-1')
    expect(getStoryState(db).kickoffPageId).toBe('page-1')
    setKickoffPageId(db, null)
    expect(getStoryState(db).kickoffPageId).toBeNull()
  })
})

describe('setCurrentPageId', () => {
  it('sets the Undo/Redo cursor', () => {
    setCurrentPageId(db, 'page-42')
    expect(getStoryState(db).currentPageId).toBe('page-42')
    setCurrentPageId(db, null)
    expect(getStoryState(db).currentPageId).toBeNull()
  })
})

describe('history cursor', () => {
  it('starts at 0 and increments', () => {
    expect(getHistoryCursorSeq(db)).toBe(0)
    setHistoryCursorSeq(db, 5)
    expect(getHistoryCursorSeq(db)).toBe(5)
  })
})
