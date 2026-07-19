#!/usr/bin/env npx tsx
/**
 * Manual harness for the format probe engine (src/inference/format-probe.ts).
 * Runs the full condition matrix against one model and prints the resulting profile.
 * Artifacts (raw SSE, observations, profile) go to data/experiments/format-probe/<stamp>-<model>/.
 *
 * Usage:
 *   npx tsx scripts/format-probe.ts <modelId> [--runs 2]
 *
 * Requires FEATHERLESS_API_KEY in .env. Burns real concurrency slots (8 sequential calls
 * by default) — big models will make this take a few minutes.
 */
import { join } from 'node:path'

try {
  process.loadEnvFile()
} catch {
  /* no .env */
}

import { runFormatProbe } from '../src/inference/format-probe.js'

const args = process.argv.slice(2)
const modelId = args[0]
if (!modelId || modelId.startsWith('--')) {
  console.error('Usage: npx tsx scripts/format-probe.ts <modelId> [--runs 2]')
  process.exit(1)
}
const runsIdx = args.indexOf('--runs')
const runs = runsIdx >= 0 ? Number(args[runsIdx + 1]) : 2

const apiKey = process.env.FEATHERLESS_API_KEY?.trim()
if (!apiKey) {
  console.error('set FEATHERLESS_API_KEY in .env')
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const slug = modelId.replace(/[^a-zA-Z0-9.-]/g, '_')
const artifactDir = join('data', 'experiments', 'format-probe', `${stamp}-${slug}`)

console.log(`Probing ${modelId} (${runs} runs/condition, sequential)…\n`)
const { profile } = await runFormatProbe(modelId, {
  apiKey,
  runsPerCondition: runs,
  artifactDir,
  onProgress: (label) => console.log(`  ${label}`),
})

console.log('\n=== Profile ===')
console.log(JSON.stringify(profile, null, 2))
console.log(`\nArtifacts: ${artifactDir}`)
