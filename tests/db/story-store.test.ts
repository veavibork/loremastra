import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createGlobalDb } from './helpers.js'
import { createUser } from '../../src/db/user-store.js'
import {
  createStory,
  getStory,
  listAllStories,
  renameStory,
  DEFAULT_STORY_NAME,
} from '../../src/db/story-store.js'

let db: Database.Database
let userId: string

beforeEach(() => {
  db = createGlobalDb()
  userId = createUser(db, 'Test', 'pw').id
})

describe('createStory', () => {
  it('creates a story with default name', () => {
    const story = createStory(db, { ownerUserId: userId, name: DEFAULT_STORY_NAME })
    expect(story.id).toBeTruthy()
    expect(story.name).toBe(DEFAULT_STORY_NAME)
    expect(story.ownerUserId).toBe(userId)
    expect(story.hidden).toBe(false)
    expect(story.filePath).toBeTruthy()
  })
})

describe('getStory', () => {
  it('returns the created story', () => {
    const created = createStory(db, { ownerUserId: userId, name: 'My Story' })
    const found = getStory(db, created.id)
    expect(found).not.toBeNull()
    expect(found!.name).toBe('My Story')
  })

  it('returns null for unknown id', () => {
    expect(getStory(db, 'nonexistent')).toBeNull()
  })
})

describe('listAllStories', () => {
  it('returns all stories', () => {
    createStory(db, { ownerUserId: userId, name: 'A' })
    createStory(db, { ownerUserId: userId, name: 'B' })
    expect(listAllStories(db)).toHaveLength(2)
  })
})

describe('renameStory', () => {
  it('renames the story', () => {
    const story = createStory(db, { ownerUserId: userId, name: 'Old' })
    renameStory(db, story.id, 'New Title')
    expect(getStory(db, story.id)!.name).toBe('New Title')
  })
})
