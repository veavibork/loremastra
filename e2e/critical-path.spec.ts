/**
 * E2E critical path — exercises the full user journey through the API.
 *
 *   login → create → setup → kickoff → post → retry
 *
 * Uses Playwright's `request` fixture (HTTP client, no browser) to test the
 * route/service/store pipeline end to end. Inference jobs are created but
 * not awaited — generation requires API keys that may not be configured in CI.
 *
 * A separate `Browser smoke` block verifies the frontend renders after login.
 */
import { test, expect } from '@playwright/test'

const TEST_USER = 'testuser'
const TEST_PASS = 'testpass'

test.describe.serial('API critical path', () => {
  let sessionId: string
  let storyId: string
  let kickoffAgentPageId: string
  let postAgentPageId: string

  test('1. login — POST /api/sessions/claim', async ({ request }) => {
    // Resolve test user's UUID from the profile picker endpoint
    const usersRes = await request.get('/api/users')
    expect(usersRes.status()).toBe(200)
    const users = (await usersRes.json()) as { id: string; displayName: string }[]
    const testUserUuid = users.find((u) => u.displayName === TEST_USER)?.id
    expect(testUserUuid, 'test user must exist in DB (run globalSetup)').toBeDefined()
    const res = await request.post('/api/sessions/claim', {
      data: { userId: testUserUuid, password: TEST_PASS },
    })
    const loginBody = await res.text()
    expect(res.status(), `login should succeed, got ${res.status()}: ${loginBody}`).toBe(200)
    const body = JSON.parse(loginBody)
    expect(body).toHaveProperty('sessionId')
    sessionId = body.sessionId as string
  })

  test('2. create story — POST /api/stories', async ({ request }) => {
    const res = await request.post('/api/stories', {
      data: { name: 'E2E Critical Path Test' },
      headers: {
        'Content-Type': 'application/json',
        'X-Loremaster-Session': sessionId,
      },
    })
    expect(res.status(), 'story creation should succeed').toBe(200)
    const body = await res.json()
    expect(body.story).toHaveProperty('id')
    expect(body.story).toHaveProperty('name')
    storyId = body.story.id as string
  })

  test('3. setup message — POST /api/stories/:id/setup/messages', async ({ request }) => {
    const res = await request.post(`/api/stories/${storyId}/setup/messages`, {
      data: { content: 'E2E setup: this story features a brave knight.' },
      headers: {
        'Content-Type': 'application/json',
        'X-Loremaster-Session': sessionId,
      },
    })
    expect(res.status(), 'setup message should succeed').toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('jobId')
    expect(body).toHaveProperty('agentPageId')
    expect(body).toHaveProperty('userPageId')

    // Verify phase is still setup (kickoff hasn't happened yet)
    const phaseRes = await request.get(`/api/stories/${storyId}/phase`, {
      headers: { 'X-Loremaster-Session': sessionId },
    })
    expect(phaseRes.status()).toBe(200)
    const phaseBody = await phaseRes.json()
    expect(phaseBody.phase).toBe('setup')
  })

  test('4. kickoff / story transition — POST /api/stories/:id/kickoff', async ({ request }) => {
    const res = await request.post(`/api/stories/${storyId}/kickoff`, {
      headers: { 'X-Loremaster-Session': sessionId },
    })
    expect(res.status(), 'kickoff should succeed').toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('jobId')
    expect(body).toHaveProperty('agentPageId')
    kickoffAgentPageId = body.agentPageId as string

    // Phase must now be 'active'
    const phaseRes = await request.get(`/api/stories/${storyId}/phase`, {
      headers: { 'X-Loremaster-Session': sessionId },
    })
    expect(phaseRes.status()).toBe(200)
    const phaseBody = await phaseRes.json()
    expect(phaseBody.phase).toBe('active')
  })

  test('5. post message — POST /api/stories/:id/messages', async ({ request }) => {
    const res = await request.post(`/api/stories/${storyId}/messages`, {
      data: { content: 'The knight draws his sword.' },
      headers: {
        'Content-Type': 'application/json',
        'X-Loremaster-Session': sessionId,
      },
    })
    expect(res.status(), 'post message should succeed').toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('jobId')
    expect(body).toHaveProperty('agentPageId')
    expect(body).toHaveProperty('userPageId')
    postAgentPageId = body.agentPageId as string
    expect(postAgentPageId).not.toBe(kickoffAgentPageId)

    // Verify log includes the new pages
    const logRes = await request.get(`/api/stories/${storyId}/log`, {
      headers: { 'X-Loremaster-Session': sessionId },
    })
    expect(logRes.status()).toBe(200)
    const logBody = await logRes.json()
    expect(logBody).toHaveProperty('entries')
    expect(Array.isArray(logBody.entries)).toBe(true)
  })

  test('6. retry generation — POST /api/stories/:id/posts/:pageId/retry', async ({ request }) => {
    const res = await request.post(`/api/stories/${storyId}/posts/${postAgentPageId}/retry`, {
      data: { guidance: 'E2E retry: make it more dramatic.' },
      headers: {
        'Content-Type': 'application/json',
        'X-Loremaster-Session': sessionId,
      },
    })
    expect(res.status(), 'retry should succeed').toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('jobId')
    expect(body).toHaveProperty('pageId', postAgentPageId)

    // Retrying a nonexistent page should fail
    const badRes = await request.post(
      `/api/stories/${storyId}/posts/00000000-0000-0000-0000-000000000000/retry`,
      {
        headers: { 'X-Loremaster-Session': sessionId },
      },
    )
    expect(badRes.status(), 'retry of nonexistent page should 404').toBe(404)
  })
})

test.describe('Browser smoke', () => {
  test('login through ClaimGate and verify StoryView renders', async ({ page }) => {
    await page.goto('/')

    // ClaimGate should be visible for unauthenticated browser
    await expect(page.locator('.claim-gate')).toBeVisible({ timeout: 5_000 })

    // Select the test user
    await page.click('button.claim-gate-user:has-text("testuser")')

    // Enter password
    await page.fill('input.claim-gate-password', TEST_PASS)

    // Submit the claim
    await page.click('button[type="submit"]')

    // After login, the story app should appear
    await expect(page.locator('.story-app')).toBeVisible({ timeout: 10_000 })

    // StoryView composer should be present (setup phase shows kickoff button)
    await expect(page.locator('form.composer')).toBeVisible()
    await expect(page.locator('form.composer textarea')).toBeVisible()

    // Verify story toolbar renders (Guide/Play toggle visible in both phases)
    await expect(page.locator('.play-toolbar')).toBeVisible()
  })
})
