import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  testDir: './e2e',
  timeout: 15_000,
  webServer: [
    {
      command: 'npm run dev',
      env: { DEV_BYPASS_SESSION_GUARD: 'true' },
      port: 4113,
      timeout: 10_000,
      reuseExistingServer: true,
    },
    {
      command: 'npm run dev',
      cwd: './web',
      port: 5173,
      timeout: 10_000,
      reuseExistingServer: true,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  use: {
    baseURL: 'http://localhost:5173',
  },
})
