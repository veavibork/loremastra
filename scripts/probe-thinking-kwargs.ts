/**
 * Compare Featherless thinking controls on DeepSeek V4-Pro:
 * enable_thinking off, thinking_budget cap, with/without assistant prefill.
 *
 * Usage:
 *   npx tsx scripts/probe-thinking-kwargs.ts
 *   PROBE_MAX_TOKENS=500 npx tsx scripts/probe-thinking-kwargs.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  FEATHERLESS_BASE_URL,
  FEATHERLESS_USER_AGENT,
} from '../src/inference/featherless-config.js'

try {
  const envText = readFileSync('.env', 'utf8')
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, '')
  }
} catch {
  /* ok */
}

const MODEL = process.env.PROBE_MODEL?.trim() || 'deepseek-ai/DeepSeek-V4-Pro'
const MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS ?? '500')
const apiKey = process.env.FEATHERLESS_API_KEY?.trim()
if (!apiKey) {
  console.error('set FEATHERLESS_API_KEY in .env')
  process.exit(1)
}

const PREFILL = '<think>\n'

const messages = [
  {
    role: 'system' as const,
    content:
      'You are a fantasy RPG narrator. Write 2 short in-character paragraphs. No meta commentary.',
  },
  { role: 'user' as const, content: 'The PC pushes open the tavern door and steps inside.' },
]

interface Scenario {
  id: string
  prefill: boolean
  chatTemplateKwargs?: Record<string, unknown>
}

const scenarios: Scenario[] = [
  { id: 'baseline_prefill', prefill: true },
  {
    id: 'enable_thinking_false_prefill',
    prefill: true,
    chatTemplateKwargs: { enable_thinking: false },
  },
  {
    id: 'enable_thinking_false_no_prefill',
    prefill: false,
    chatTemplateKwargs: { enable_thinking: false },
  },
  {
    id: 'thinking_budget_100_prefill',
    prefill: true,
    chatTemplateKwargs: { thinking_budget: 100 },
  },
  {
    id: 'enable_thinking_true_budget_100_prefill',
    prefill: true,
    chatTemplateKwargs: { enable_thinking: true, thinking_budget: 100 },
  },
  {
    id: 'enable_thinking_false_budget_100_prefill',
    prefill: true,
    chatTemplateKwargs: { enable_thinking: false, thinking_budget: 100 },
  },
  { id: 'no_prefill_no_kwargs', prefill: false },
]

const only = process.env.PROBE_ONLY?.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const activeScenarios = only?.length ? scenarios.filter((s) => only.includes(s.id)) : scenarios

interface RunResult {
  scenario: string
  httpStatus: number
  wallMs: number
  firstReasoningMs: number | null
  firstContentMs: number | null
  reasoningChars: number
  contentChars: number
  reasoningPreview: string
  contentPreview: string
  /** Would streamWithFallback reject and retry? */
  wouldRetry: boolean
  retryReason: string | null
  deltaKeys: Record<string, number>
  usage: unknown
  error?: string
}

function looksProseLike(text: string): boolean {
  const t = text.trim()
  if (t.length < 80) return false
  // IC-ish: quoted dialogue, scene narration openings, past-tense sensory beats
  if (
    /^The [A-Z]/.test(t) ||
    /^"[A-Za-z]/.test(t) ||
    /\b(he|she|they) (said|looked|stepped|turned)\b/i.test(t)
  ) {
    return true
  }
  return false
}

function looksMetaReasoning(text: string): boolean {
  return /\b(should|therefore|I need|the PC|content register|write|respond|scene|NPC|GM|meta)\b/i.test(
    text,
  )
}

async function runScenario(scenario: Scenario): Promise<RunResult> {
  const wireMessages = scenario.prefill
    ? [...messages, { role: 'assistant' as const, content: PREFILL }]
    : messages

  const body: Record<string, unknown> = {
    model: MODEL,
    messages: wireMessages,
    temperature: 1,
    max_tokens: MAX_TOKENS,
    stream: true,
    ...(scenario.chatTemplateKwargs ? { chat_template_kwargs: scenario.chatTemplateKwargs } : {}),
  }

  const t0 = Date.now()
  const wallLimitMs = Number(process.env.PROBE_WALL_MS ?? '120000')
  const abort = AbortController ? new AbortController() : null
  const wallTimer = abort
    ? setTimeout(() => abort.abort(new Error(`wall timeout ${wallLimitMs}ms`)), wallLimitMs)
    : null
  let firstReasoningMs: number | null = null
  let firstContentMs: number | null = null
  let reasoning = ''
  let content = ''
  const deltaKeys: Record<string, number> = {}
  let usage: unknown = null

  try {
    const res = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': FEATHERLESS_USER_AGENT,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: abort?.signal,
    })

    if (!res.ok || !res.body) {
      return {
        scenario: scenario.id,
        httpStatus: res.status,
        wallMs: Date.now() - t0,
        firstReasoningMs: null,
        firstContentMs: null,
        reasoningChars: 0,
        contentChars: 0,
        reasoningPreview: '',
        contentPreview: '',
        wouldRetry: false,
        retryReason: null,
        deltaKeys: {},
        usage: null,
        error: await res.text(),
      }
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: Record<string, unknown> }>
            usage?: unknown
          }
          if (parsed.usage) usage = parsed.usage
          const delta = parsed.choices?.[0]?.delta
          if (!delta) continue
          for (const key of Object.keys(delta)) {
            if (delta[key] != null) deltaKeys[key] = (deltaKeys[key] ?? 0) + 1
          }
          const ms = Date.now() - t0
          const r =
            (typeof delta.reasoning === 'string' ? delta.reasoning : '') ||
            (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '')
          if (r) {
            reasoning += r
            if (firstReasoningMs == null) firstReasoningMs = ms
          }
          if (typeof delta.content === 'string') {
            content += delta.content
            if (firstContentMs == null) firstContentMs = ms
          }
        } catch {
          /* ignore */
        }
      }
    }

    const sawReasoning = reasoning.trim().length > 0
    const hasContent = content.trim().length > 0
    let wouldRetry = false
    let retryReason: string | null = null
    if (!hasContent && sawReasoning) {
      wouldRetry = true
      retryReason = 'reasoning but no answer content'
    } else if (!hasContent && !sawReasoning) {
      wouldRetry = true
      retryReason = 'empty completion'
    }

    return {
      scenario: scenario.id,
      httpStatus: res.status,
      wallMs: Date.now() - t0,
      firstReasoningMs,
      firstContentMs,
      reasoningChars: reasoning.length,
      contentChars: content.length,
      reasoningPreview: reasoning.slice(0, 280).replace(/\s+/g, ' '),
      contentPreview: content.slice(0, 280).replace(/\s+/g, ' '),
      wouldRetry,
      retryReason,
      deltaKeys,
      usage,
    }
  } catch (err) {
    return {
      scenario: scenario.id,
      httpStatus: 0,
      wallMs: Date.now() - t0,
      firstReasoningMs: null,
      firstContentMs: null,
      reasoningChars: 0,
      contentChars: 0,
      reasoningPreview: '',
      contentPreview: '',
      wouldRetry: false,
      retryReason: null,
      deltaKeys: {},
      usage: null,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (wallTimer) clearTimeout(wallTimer)
  }
}

console.log(`model=${MODEL} max_tokens=${MAX_TOKENS}\n`)

const results: RunResult[] = []
for (const scenario of activeScenarios) {
  process.stderr.write(`running ${scenario.id}… `)
  const result = await runScenario(scenario)
  results.push(result)
  process.stderr.write(`${result.wouldRetry ? 'RETRY' : 'ok'} (${result.wallMs}ms)\n`)
  // small gap — avoid concurrency slot pile-up on Featherless
  await new Promise((r) => setTimeout(r, 2000))
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.resolve('data/experiments/thinking-kwargs')
mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, `${stamp}.json`)
writeFileSync(
  outPath,
  JSON.stringify({ model: MODEL, maxTokens: MAX_TOKENS, results }, null, 2),
  'utf8',
)

console.log('\n=== SUMMARY ===\n')
for (const r of results) {
  console.log(`## ${r.scenario}`)
  if (r.error) {
    console.log(`  ERROR: ${r.error.slice(0, 200)}`)
    continue
  }
  console.log(`  delta keys: ${JSON.stringify(r.deltaKeys)}`)
  console.log(
    `  timing ms: reasoning@${r.firstReasoningMs ?? '—'} content@${r.firstContentMs ?? '—'} wall=${r.wallMs}`,
  )
  console.log(`  chars: reasoning=${r.reasoningChars} content=${r.contentChars}`)
  console.log(`  wouldRetry: ${r.wouldRetry}${r.retryReason ? ` (${r.retryReason})` : ''}`)
  console.log(
    `  reasoning style: meta=${looksMetaReasoning(r.reasoningPreview)} prose-like=${looksProseLike(r.reasoningPreview)}`,
  )
  if (r.reasoningPreview) console.log(`  reasoning▸ ${r.reasoningPreview}`)
  if (r.contentPreview) console.log(`  content▸ ${r.contentPreview}`)
  if (r.usage) console.log(`  usage: ${JSON.stringify(r.usage)}`)
  console.log()
}

console.error(`\nWrote ${outPath}`)
