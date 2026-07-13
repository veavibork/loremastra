import bcrypt from 'bcryptjs'
import { getGlobalDb } from '../src/db/global-db.js'
import { createUser, listUsers } from '../src/db/user-store.js'

/**
 * Seeds a known test user for E2E critical path tests.
 * Runs once before all tests via Playwright globalSetup.
 */
async function globalSetup() {
  const db = getGlobalDb()
  const users = listUsers(db)

  const existing = users.find((u) => u.displayName === 'testuser')
  if (existing) {
    console.log('[e2e setup] Test user "testuser" already exists (id=%s)', existing.id)
    return
  }

  const passwordHash = bcrypt.hashSync('testpass', 10)
  const user = createUser(db, 'testuser', passwordHash)
  console.log('[e2e setup] Created test user "testuser" (id=%s)', user.id)
}

export default globalSetup
