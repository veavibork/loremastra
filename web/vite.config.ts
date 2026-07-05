import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function commitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Stamped once at build time so the running app can show which deploy is actually live —
  // see App.tsx's header.
  define: {
    __BUILD_INFO__: JSON.stringify({ commit: commitHash(), builtAt: new Date().toISOString() }),
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:4113',
        changeOrigin: true,
      },
    },
  },
})
