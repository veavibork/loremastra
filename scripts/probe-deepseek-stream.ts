/**
 * Dump raw Featherless SSE chunks for DeepSeek-V4-Pro — content vs reasoning_content,
 * with and without assistant prefill. Usage: npx tsx scripts/probe-deepseek-stream.ts
 */
import { readFileSync } from 'node:fs'
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
  // .env optional if env vars already set
}

const MODEL = 'deepseek-ai/DeepSeek-V4-Pro'
const apiKey = process.env.FEATHERLESS_API_KEY?.trim()
if (!apiKey) {
  console.error('set FEATHERLESS_API_KEY in .env')
  process.exit(1)
}

const messages = [
  {
    role: 'system' as const,
    content: 'You are a fantasy RPG narrator. Reply in 2-3 short IC paragraphs.',
  },
  { role: 'user' as const, content: 'PC opens the tavern door and steps inside.' },
]

async function probe(label: string, body: Record<string, unknown>): Promise<void> {
  console.log(`\n${'='.repeat(72)}\n${label}\n${'='.repeat(72)}`)
  const res = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': FEATHERLESS_USER_AGENT,
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    console.error('HTTP', res.status, await res.text())
    return
  }
  if (!res.body) {
    console.error('no body')
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let chunkIndex = 0
  let contentAcc = ''
  let reasoningAcc = ''

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
      if (payload === '[DONE]') {
        console.log('\n[DONE]')
        console.log('\n--- accumulated content ---\n', JSON.stringify(contentAcc))
        console.log('\n--- accumulated reasoning_content ---\n', JSON.stringify(reasoningAcc))
        return
      }
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: { content?: string | null; reasoning_content?: string | null }
            finish_reason?: string | null
          }>
        }
        const delta = parsed.choices?.[0]?.delta
        const content = delta?.content ?? null
        const reasoning = delta?.reasoning_content ?? null
        if (content) contentAcc += content
        if (reasoning) reasoningAcc += reasoning
        if (content != null || reasoning != null || parsed.choices?.[0]?.finish_reason) {
          chunkIndex++
          console.log(
            `\n#${chunkIndex}`,
            JSON.stringify({
              content,
              reasoning_content: reasoning,
              finish_reason: parsed.choices?.[0]?.finish_reason ?? null,
            }),
          )
        }
      } catch {
        console.log('parse error:', payload.slice(0, 120))
      }
    }
  }
}

await probe('A) No prefill', {
  model: MODEL,
  messages,
  temperature: 1,
  max_tokens: 256,
  stream: true,
})

// Skip A on quick re-run — comment out above when iterating

await probe('B) Prefill (production — open redacted_thinking block)', {
  model: MODEL,
  messages: [...messages, { role: 'assistant', content: '<think>\n' }],
  temperature: 1,
  max_tokens: 512,
  stream: true,
})

await probe('C) enable_thinking via chat_template_kwargs', {
  model: MODEL,
  messages,
  temperature: 1,
  max_tokens: 512,
  stream: true,
  chat_template_kwargs: { enable_thinking: true },
})

await probe('D) Prefill + enable_thinking', {
  model: MODEL,
  messages: [...messages, { role: 'assistant', content: '<think>\n' }],
  temperature: 1,
  max_tokens: 512,
  stream: true,
  chat_template_kwargs: { enable_thinking: true },
})
