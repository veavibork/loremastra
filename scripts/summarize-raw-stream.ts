/**
 * Summarize a probe-deepseek-raw.jsonl file with no format assumptions —
 * reports every delta key seen, phase timing, and sample payloads.
 *
 * Usage: npx tsx scripts/summarize-raw-stream.ts [path-to.jsonl]
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const file =
  process.argv[2] ?? path.resolve('data/experiments/deepseek-raw/2026-07-04T17-29-06-508Z.jsonl')

const text = readFileSync(file, 'utf8')
const lines = text.split('\n')

const deltaKeys = new Map<string, number>()
let firstMs: number | null = null
let firstReasoningMs: number | null = null
let firstContentMs: number | null = null
let reasoningChars = 0
let contentChars = 0
const samples: Record<string, unknown> = {}

for (const line of lines) {
  const m = line.match(/^DATA_JSON \+(\d+)ms$/)
  if (!m) continue
  const ms = Number(m[1])
  const idx = lines.indexOf(line)
  const block = lines.slice(idx + 1).join('\n')
  const end = block.indexOf('\nSSE_LINE ')
  const jsonText = end === -1 ? block : block.slice(0, end)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    continue
  }
  if (firstMs == null) firstMs = ms
  const delta = (parsed as { choices?: Array<{ delta?: Record<string, unknown> }> })?.choices?.[0]
    ?.delta
  if (!delta) continue
  for (const key of Object.keys(delta)) {
    deltaKeys.set(key, (deltaKeys.get(key) ?? 0) + 1)
    if (!samples[key] && delta[key] != null) samples[key] = delta[key]
  }
  if (typeof delta.reasoning === 'string') {
    reasoningChars += delta.reasoning.length
    if (firstReasoningMs == null) firstReasoningMs = ms
  }
  if (typeof delta.reasoning_content === 'string') {
    reasoningChars += delta.reasoning_content.length
    if (firstReasoningMs == null) firstReasoningMs = ms
  }
  if (typeof delta.content === 'string') {
    contentChars += delta.content.length
    if (firstContentMs == null) firstContentMs = ms
  }
}

console.log('file:', file)
console.log(
  'delta keys seen:',
  Object.fromEntries([...deltaKeys.entries()].sort((a, b) => b[1] - a[1])),
)
console.log('first sample per key:', samples)
console.log('timing ms:', {
  firstData: firstMs,
  firstReasoning: firstReasoningMs,
  firstContent: firstContentMs,
})
console.log('accumulated chars:', { reasoning: reasoningChars, content: contentChars })
