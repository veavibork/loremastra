/**
 * Empirical shape probe across model families — one plain streaming call per model, no
 * chat_template_kwargs (matching a real first-turn request today). Logs every delta key seen,
 * accumulated content vs any reasoning-shaped field, and whether <think> tags show up inline in
 * content. Written to answer: "does this model's JSON shape differ from DeepSeek's?" before
 * touching isReasoningModel()'s hardcoded name gate.
 *
 * Usage: npx tsx scripts/probe-model-shapes.ts
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import {
  FEATHERLESS_BASE_URL,
  FEATHERLESS_USER_AGENT,
} from '../src/inference/featherless-config.js'

try {
  process.loadEnvFile()
} catch {
  /* ok */
}

const apiKey = process.env.FEATHERLESS_API_KEY?.trim()
if (!apiKey) {
  console.error('set FEATHERLESS_API_KEY in .env')
  process.exit(1)
}

const MODELS = [
  'moonshotai/Kimi-K2.7-Code',
  'moonshotai/Kimi-K2-Thinking',
  'deepseek-ai/DeepSeek-V4-Pro',
  'Qwen/Qwen3-8B',
  'zai-org/GLM-4.7-Flash',
  'openai/gpt-oss-20b',
  'google/gemma-4-E2B-it',
]

const messages = [
  {
    role: 'system' as const,
    content:
      'You are a fantasy RPG narrator. Write 2 short in-character paragraphs. No meta commentary.',
  },
  { role: 'user' as const, content: 'The PC pushes open the tavern door and steps inside.' },
]

interface Result {
  model: string
  httpStatus: number
  error?: string
  deltaKeys: Record<string, number>
  contentChars: number
  reasoningFieldChars: number
  contentHasThinkTag: boolean
  contentPreview: string
  reasoningFieldPreview: string
  finishReason: string | null
  usage: unknown
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.resolve('data/experiments/model-shapes')
mkdirSync(outDir, { recursive: true })
const rawPath = path.join(outDir, `${stamp}-raw.jsonl`)

async function probe(model: string): Promise<Result> {
  const deltaKeys: Record<string, number> = {}
  let content = ''
  let reasoningField = ''
  let finishReason: string | null = null
  let usage: unknown = null

  let res: Response
  try {
    res = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': FEATHERLESS_USER_AGENT,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 1,
        max_tokens: 300,
        stream: true,
      }),
    })
  } catch (err) {
    return {
      model,
      httpStatus: 0,
      error: err instanceof Error ? err.message : String(err),
      deltaKeys: {},
      contentChars: 0,
      reasoningFieldChars: 0,
      contentHasThinkTag: false,
      contentPreview: '',
      reasoningFieldPreview: '',
      finishReason: null,
      usage: null,
    }
  }

  if (!res.ok || !res.body) {
    return {
      model,
      httpStatus: res.status,
      error: await res.text(),
      deltaKeys: {},
      contentChars: 0,
      reasoningFieldChars: 0,
      contentHasThinkTag: false,
      contentPreview: '',
      reasoningFieldPreview: '',
      finishReason: null,
      usage: null,
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
      appendFileSync(rawPath, `${model} | ${payload}\n`, 'utf8')
      if (payload === '[DONE]') continue
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>
          usage?: unknown
        }
        if (parsed.usage) usage = parsed.usage
        const choice = parsed.choices?.[0]
        if (choice?.finish_reason) finishReason = choice.finish_reason
        const delta = choice?.delta
        if (!delta) continue
        for (const key of Object.keys(delta)) {
          if (delta[key] != null) deltaKeys[key] = (deltaKeys[key] ?? 0) + 1
        }
        if (typeof delta.content === 'string') content += delta.content
        for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
          const v = delta[key]
          if (typeof v === 'string') reasoningField += v
        }
      } catch {
        /* ignore malformed line */
      }
    }
  }

  return {
    model,
    httpStatus: res.status,
    deltaKeys,
    contentChars: content.length,
    reasoningFieldChars: reasoningField.length,
    contentHasThinkTag: /<think>|<\/think>/i.test(content),
    contentPreview: content.slice(0, 220).replace(/\s+/g, ' '),
    reasoningFieldPreview: reasoningField.slice(0, 220).replace(/\s+/g, ' '),
    finishReason,
    usage,
  }
}

const results: Result[] = []
for (const model of MODELS) {
  process.stderr.write(`probing ${model}… `)
  const r = await probe(model)
  results.push(r)
  process.stderr.write(r.error ? `ERROR ${r.httpStatus}\n` : `ok (${r.httpStatus})\n`)
  await new Promise((resolve) => setTimeout(resolve, 1500))
}

const summaryPath = path.join(outDir, `${stamp}-summary.json`)
writeFileSync(summaryPath, JSON.stringify(results, null, 2), 'utf8')

console.log('\n=== SUMMARY ===\n')
for (const r of results) {
  console.log(`## ${r.model}`)
  if (r.error) {
    console.log(`  ERROR ${r.httpStatus}: ${r.error.slice(0, 200)}`)
    console.log()
    continue
  }
  console.log(`  delta keys seen: ${JSON.stringify(r.deltaKeys)}`)
  console.log(`  content chars: ${r.contentChars}  reasoning-field chars: ${r.reasoningFieldChars}`)
  console.log(`  <think> tag inline in content: ${r.contentHasThinkTag}`)
  console.log(`  finish_reason: ${r.finishReason}`)
  if (r.reasoningFieldPreview) console.log(`  reasoning-field▸ ${r.reasoningFieldPreview}`)
  if (r.contentPreview) console.log(`  content▸ ${r.contentPreview}`)
  if (r.usage) console.log(`  usage: ${JSON.stringify(r.usage)}`)
  console.log()
}

console.error(`\nWrote raw: ${rawPath}\nWrote summary: ${summaryPath}`)
