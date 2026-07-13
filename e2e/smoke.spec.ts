import { test, expect } from '@playwright/test'

// ----------------------------------------------------------------
// API contract tests — verify route shapes, status codes, and guard behavior.
// These use Playwright's `request` fixture (HTTP client, no browser).
// The dev server MUST be running (playwright.config.ts auto-starts it).
// ----------------------------------------------------------------

// --- Prompts (public) ---
test('GET /api/prompts returns catalog', async ({ request }) => {
  const res = await request.get('/api/prompts')
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body).toHaveProperty('prompts')
  expect(Array.isArray(body.prompts)).toBe(true)
})

// --- Sessions (public, no session guard) ---
test('POST /api/sessions/claim with missing credentials returns 400', async ({ request }) => {
  const res = await request.post('/api/sessions/claim', {
    data: { userId: '', password: '' },
    headers: { 'Content-Type': 'application/json' },
  })
  expect(res.status()).toBe(400)
  const body = await res.json()
  expect(body).toHaveProperty('error')
})

// --- Client-errors (semi-public) ---
test('POST /api/client-errors with valid body returns non-5xx', async ({ request }) => {
  const res = await request.post('/api/client-errors', {
    data: { severity: 'info', message: 'smoke test' },
    headers: { 'Content-Type': 'application/json' },
  })
  expect(res.status()).toBeLessThan(500)
  const body = await res.json()
  expect(body).toHaveProperty(res.status() === 200 ? 'clientError' : 'error')
})

test('POST /api/client-errors with missing body returns non-5xx', async ({ request }) => {
  const res = await request.post('/api/client-errors', {
    data: {},
    headers: { 'Content-Type': 'application/json' },
  })
  expect(res.status()).toBeLessThan(500)
})

test('GET /api/client-errors returns JSON array', async ({ request }) => {
  const res = await request.get('/api/client-errors')
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body).toHaveProperty('errors')
  expect(Array.isArray(body.errors)).toBe(true)
})

// --- Settings-spaces (requires session) ---
test('GET /api/settings-spaces/:space rejects unknown space', async ({ request }) => {
  const res = await request.get('/api/settings-spaces/bogus-space')
  expect(res.status()).toBeGreaterThanOrEqual(400)
})

// --- Layout (requires session) ---
test('GET /api/layout returns layout config', async ({ request }) => {
  const res = await request.get('/api/layout')
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body).toHaveProperty('config')
})

// --- Stories (requires session + seeded DB) ---
test('GET /api/stories returns non-5xx', async ({ request }) => {
  const res = await request.get('/api/stories')
  expect(res.status()).toBeLessThan(500)
})

// --- OPTIONS preflight (CORS) ---
test('OPTIONS /api/prompts handles preflight', async ({ request }) => {
  const res = await request.fetch('/api/prompts', { method: 'OPTIONS' })
  expect(res.status()).toBeLessThan(500)
})
