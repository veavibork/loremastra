import {
  FEATHERLESS_BASE_URL,
  FEATHERLESS_USER_AGENT,
} from '../src/inference/featherless-config.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const apiKey = process.env.FEATHERLESS_API_KEY
if (!apiKey) {
  console.error('set FEATHERLESS_API_KEY')
  process.exit(1)
}

const evalScript = readFileSync(join('scripts', 'evaluate-worker-models.ts'), 'utf-8')
const feathModels = readFileSync(join('src', 'inference', 'featherless-models.ts'), 'utf-8')

const systemPrompt =
  'You are a precise technical analyst. Follow instructions exactly. Keep output under 200 words.'
const userPrompt = `Analyze these two files and write your findings to test-results/<MODEL>-analysis.md.

## File 1: scripts/evaluate-worker-models.ts

\`\`\`typescript
${evalScript}
\`\`\`

## File 2: src/inference/featherless-models.ts

\`\`\`typescript
${feathModels}
\`\`\`

Write test-results/<MODEL>-analysis.md with exactly three sections using ## headers:
1. ## How listModels works — params, pagination, return shape
2. ## How the eval script uses it — filters, paging loop, scoring entry point
3. ## One improvement you would suggest

Keep the entire file under 200 words. Use proper Markdown. Call write_file exactly once.`

const tools = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
]

const MODELS = [
  'Qwen/Qwen2.5-Coder-7B-Instruct',
  'NousResearch/Hermes-3-Llama-3.1-8B',
  'Qwen/Qwen2.5-Coder-32B-Instruct',
  'Qwen/Qwen2.5-32B-Instruct',
]

async function main() {
  for (const model of MODELS) {
    const start = performance.now()
    console.error(`Testing ${model}...`)
    try {
      const r = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': FEATHERLESS_USER_AGENT,
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0,
          max_tokens: 2048,
          stream: false,
          tools,
          tool_choice: 'auto',
        }),
      })
      const ms = Math.round(performance.now() - start)
      if (!r.ok) {
        const body = await r.text().catch(() => '')
        console.log(`${model}: FAIL HTTP ${r.status} — ${body.slice(0, 200)}`)
        continue
      }
      const d = (await r.json()) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number }
        choices?: Array<{
          message?: {
            content?: string | null
            tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
          }
        }>
      }
      const msg = d.choices?.[0]?.message
      const tc = msg?.tool_calls?.[0]?.function
      const tokIn = d.usage?.prompt_tokens ?? 0
      const tokOut = d.usage?.completion_tokens ?? 0
      const tcName = tc?.name ?? ''
      let path = ''
      let content = ''
      if (tcName === 'write_file') {
        try {
          const args = JSON.parse(tc?.arguments ?? '{}') as { path?: string; content?: string }
          path = args.path ?? ''
          content = args.content ?? ''
        } catch {
          /* ignore */
        }
      }
      const hasAll =
        content.includes('## How listModels') &&
        content.includes('## How the eval script') &&
        content.includes('## One improvement')
      const wc = content.split(/\s+/).filter(Boolean).length
      const expectedPath = `test-results/${model.split('/').pop()}-analysis.md`
      console.log(
        `${model}: ${ms}ms | ${tokIn}/${tokOut} tok | tool="${tcName}" | path="${path}" ${path === expectedPath ? '✓' : '✗'} | sections=${hasAll ? '✓' : '✗'} | words=${wc}`,
      )
    } catch (e) {
      console.log(`${model}: EXCEPTION ${String(e).slice(0, 200)}`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
