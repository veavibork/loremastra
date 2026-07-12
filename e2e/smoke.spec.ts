import { test, expect } from '@playwright/test'

test('GET /api/users returns JSON array', async ({ request }) => {
  const res = await request.get('/api/users')
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toContain('application/json')

  const body = await res.json()
  expect(Array.isArray(body)).toBe(true)
})

test('GET /api/users with OPTIONS preflight', async ({ request }) => {
  const res = await request.fetch('/api/users', { method: 'OPTIONS' })
  expect(res.status()).toBeLessThan(500)
})

test('GET /api/debug/slots is guarded (no session)', async ({ request }) => {
  const res = await request.get('/api/debug/slots')
  expect(res.status()).toBeGreaterThanOrEqual(400)
})
