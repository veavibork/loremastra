import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createGlobalDb } from './helpers.js'
import {
  createUser,
  listUsers,
  getUserById,
  updateDisplayName,
  updatePassword,
  DisplayNameTakenError,
} from '../../src/db/user-store.js'

let db: Database.Database

beforeEach(() => {
  db = createGlobalDb()
})

describe('createUser', () => {
  it('creates a user and returns public profile', () => {
    const user = createUser(db, 'Test User', 'hashed-password')
    expect(user.id).toBeTruthy()
    expect(user.displayName).toBe('Test User')
    expect(user.createdAt).toBeTruthy()
    expect((user as Record<string, unknown>).passwordVerifier).toBeUndefined()
  })
})

describe('listUsers', () => {
  it('returns all users ordered by creation', () => {
    createUser(db, 'Alice', 'pw1')
    createUser(db, 'Bob', 'pw2')
    const users = listUsers(db)
    expect(users).toHaveLength(2)
    expect(users[0]!.displayName).toBe('Alice')
    expect(users[1]!.displayName).toBe('Bob')
  })
})

describe('getUserById', () => {
  it('returns full auth row including password verifier', () => {
    const user = createUser(db, 'Test', 'hashed-pw')
    const auth = getUserById(db, user.id)
    expect(auth).not.toBeNull()
    expect(auth!.displayName).toBe('Test')
    expect(auth!.passwordVerifier).toBe('hashed-pw')
  })

  it('returns null for unknown id', () => {
    expect(getUserById(db, 'nonexistent')).toBeNull()
  })
})

describe('updateDisplayName', () => {
  it('updates the display name', () => {
    const user = createUser(db, 'Old Name', 'pw')
    const updated = updateDisplayName(db, user.id, 'New Name')
    expect(updated.displayName).toBe('New Name')
    expect(getUserById(db, user.id)!.displayName).toBe('New Name')
  })

  it('rejects duplicate names case-insensitively', () => {
    createUser(db, 'Alpha', 'pw')
    const user2 = createUser(db, 'Beta', 'pw')
    expect(() => updateDisplayName(db, user2.id, 'alpha')).toThrow(DisplayNameTakenError)
  })

  it('allows same-name update on own record', () => {
    const user = createUser(db, 'Gamma', 'pw')
    const updated = updateDisplayName(db, user.id, 'Gamma')
    expect(updated.displayName).toBe('Gamma')
  })
})

describe('updatePassword', () => {
  it('changes the password verifier', () => {
    const user = createUser(db, 'User', 'pw')
    updatePassword(db, user.id, 'new-hash')
    const auth = getUserById(db, user.id)!
    expect(auth.passwordVerifier).toBe('new-hash')
  })
})
