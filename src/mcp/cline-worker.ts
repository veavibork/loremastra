#!/usr/bin/env node
/**
 * Cline worker MCP server — gives Cline access to a cheap 1-slot Featherless model
 * for lightweight code lookup / Q&A tasks, so simple "where is X defined" questions
 * don't consume the main model's context or concurrency slots.
 *
 * Uses completeChat() from the existing inference layer — no tool-calling needed,
 * just plain completions. The model reads file contents / grep results and answers
 * a question about them.
 *
 * Configuration:
 *   CLINE_WORKER_API_KEY  — Featherless API key (required)
 *   CLINE_WORKER_MODEL    — model id (default: NousResearch/Hermes-3-Llama-3.1-8B)
 *
 * Registered in .mcp.json as "cline-worker". Runs as a standalone stdio MCP server,
 * same pattern as src/mcp/dev-server.ts.
 */

// Future: batch_ask tool — accept an array of tasks, fan them out as parallel
// completeChat calls via Promise.all, return all results. With a 1-slot model
// (Qwen2.5-7B) and the worker's own API key, 4 tasks = 4 Featherless slots
// from an independent pool. Stateless, read-only — no file edits or tool-calling.
// ~50 LOC addition. Investigated 2026-07-12, shelved for now.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { completeChat, type ChatMessage } from '../inference/featherless.js'
import type { AgentProfile } from '../config.js'
import { FEATHERLESS_BASE_URL, FEATHERLESS_USER_AGENT } from '../inference/featherless-config.js'

try {
  process.loadEnvFile()
} catch {
  // no .env present; rely on process.env as-is
}

const API_KEY = process.env.CLINE_WORKER_API_KEY ?? ''
const MODEL = process.env.CLINE_WORKER_MODEL ?? 'Qwen2.5-7B-Instruct'

const MAX_FILE_CHARS = 28_000
const MAX_GREP_RESULTS = 50
const MAX_GREP_CONTEXT_LINES = 2

function workerProfile(): AgentProfile {
  return {
    model: MODEL,
    temperature: 0.3,
    responseLimit: 2048,
    contextLimit: 32000,
    provider: 'featherless',
    concurrencyCost: 1,
  }
}

const server = new McpServer({ name: 'cline-worker', version: '0.1.0' })

function textResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  }
}

function readFileBounded(
  filePath: string,
  maxChars: number,
): { content: string; truncated: boolean } {
  const content = readFileSync(filePath, 'utf8')
  if (content.length <= maxChars) return { content, truncated: false }
  return { content: content.slice(0, maxChars), truncated: true }
}

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)
}

function grepCodebase(
  searchPath: string,
  pattern: string,
  options: { maxResults?: number; contextLines?: number; filePattern?: string },
): {
  matches: Array<{ file: string; line: number; text: string; context: string[] }>
  filesSearched: number
  truncated: boolean
} {
  const maxResults = options.maxResults ?? MAX_GREP_RESULTS
  const contextLines = options.contextLines ?? MAX_GREP_CONTEXT_LINES
  const filePattern = options.filePattern
  const root = resolvePath(searchPath)

  let regex: RegExp
  try {
    regex = new RegExp(pattern, 'i')
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }

  const matches: Array<{ file: string; line: number; text: string; context: string[] }> = []
  let filesSearched = 0
  let truncated = false

  const extensions = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.json',
    '.css',
    '.html',
    '.md',
    '.mjs',
    '.cjs',
    '.mts',
    '.cts',
  ])

  const skipDirs = new Set(['node_modules', 'dist', '.git', 'data', '.claude'])

  function walk(dir: string) {
    if (truncated) return
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      const fullPath = path.join(dir, entry)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (skipDirs.has(entry)) continue
        walk(fullPath)
      } else {
        if (filePattern && !entry.match(filePattern)) continue
        const ext = path.extname(entry)
        if (!extensions.has(ext) && !filePattern) continue
        filesSearched++
        let content: string
        try {
          content = readFileSync(fullPath, 'utf8')
        } catch {
          continue
        }
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            const start = Math.max(0, i - contextLines)
            const end = Math.min(lines.length, i + contextLines + 1)
            const context = lines.slice(start, end).map((l, idx) => {
              const lineNum = start + idx + 1
              const marker = lineNum === i + 1 ? '>>' : '  '
              return `${marker} ${lineNum}: ${l}`
            })
            matches.push({
              file: path.relative(process.cwd(), fullPath),
              line: i + 1,
              text: lines[i]!,
              context,
            })
            if (matches.length >= maxResults) {
              truncated = true
              return
            }
          }
        }
      }
    }
  }

  walk(root)
  return { matches, filesSearched, truncated }
}

server.registerTool(
  'ask_worker',
  {
    description:
      'Ask a cheap 1-slot Featherless model (Hermes-3) a question about the codebase. ' +
      'Provide file paths to include as context, or a search pattern to grep first. ' +
      'The model reads the provided context and answers concisely. ' +
      "Use this for simple lookups ('where is X defined', 'what does this function do') " +
      "to avoid consuming the main model's context window or concurrency slots.",
    inputSchema: {
      question: z.string().describe('The question to ask the worker model.'),
      files: z
        .array(z.string())
        .optional()
        .describe(
          'File paths (relative to cwd or absolute) to include as context for the question.',
        ),
      searchPattern: z
        .string()
        .optional()
        .describe(
          'Regex pattern to grep across the codebase. Results are included as context before the question.',
        ),
      searchPath: z
        .string()
        .optional()
        .describe('Directory to search (relative to cwd or absolute). Defaults to cwd.'),
      filePattern: z
        .string()
        .optional()
        .describe("Optional glob/regex to filter which files to search (e.g. '\\\\.ts$')."),
    },
  },
  async ({ question, files, searchPattern, searchPath, filePattern }) => {
    if (!API_KEY) {
      return textResult({
        error:
          'CLINE_WORKER_API_KEY is not set in .env. Add a Featherless API key to use the worker.',
      })
    }

    if (filePattern) {
      try {
        // walk() uses this directly as `entry.match(filePattern)`, which compiles it as a RegExp
        // under the hood — an invalid pattern (e.g. '(') throws a SyntaxError synchronously,
        // outside the try/catch below. Validate it up front so bad input gets the same graceful
        // { error } shape as this tool's other input-validation failures, not a raw internal error.
        new RegExp(filePattern)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return textResult({ error: `Invalid filePattern regex: ${message}` })
      }
    }

    const contextParts: string[] = []
    let truncated = false

    if (searchPattern) {
      const searchRoot = searchPath ?? process.cwd()
      const result = grepCodebase(searchRoot, searchPattern, { filePattern })
      if (result.matches.length > 0) {
        contextParts.push('=== GREP RESULTS ===')
        contextParts.push(`Searched ${result.filesSearched} files for /${searchPattern}/`)
        if (filePattern) contextParts.push(`File filter: ${filePattern}`)
        contextParts.push('')
        for (const m of result.matches) {
          contextParts.push(`--- ${m.file}:${m.line} ---`)
          contextParts.push(...m.context)
          contextParts.push('')
        }
        if (result.truncated) {
          contextParts.push(`(results truncated at ${MAX_GREP_RESULTS} matches)`)
          truncated = true
        }
      } else {
        contextParts.push(
          `=== GREP RESULTS ===\nNo matches found for /${searchPattern}/ in ${result.filesSearched} files.`,
        )
      }
    }

    if (files && files.length > 0) {
      const perFileBudget = Math.floor(MAX_FILE_CHARS / files.length)
      contextParts.push('=== FILE CONTENTS ===')
      for (const filePath of files) {
        const resolved = resolvePath(filePath)
        if (!existsSync(resolved)) {
          contextParts.push(`--- ${filePath} ---\n(file not found)`)
          continue
        }
        const stat = statSync(resolved)
        if (stat.isDirectory()) {
          contextParts.push(`--- ${filePath} ---\n(is a directory, skipping)`)
          continue
        }
        const { content, truncated: fileTruncated } = readFileBounded(resolved, perFileBudget)
        contextParts.push(`--- ${filePath} ---`)
        contextParts.push(content)
        if (fileTruncated) {
          contextParts.push(`...(file truncated at ${perFileBudget} chars)`)
          truncated = true
        }
        contextParts.push('')
      }
    }

    if (contextParts.length === 0) {
      return textResult({
        error:
          "No context provided. Include at least one of 'files' or 'searchPattern' so the worker has code to answer about.",
      })
    }

    const systemPrompt =
      'You are a code lookup assistant working on the Loremaster project. ' +
      'You are given file contents and/or grep results, then a question. ' +
      'Answer concisely and accurately. Cite file:line when referencing code. ' +
      "If the answer isn't in the provided context, say so plainly. " +
      'Do not speculate or make up information.'

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: contextParts.join('\n') + '\n\n=== QUESTION ===\n' + question },
    ]

    try {
      const answer = await completeChat(workerProfile(), API_KEY, messages, {
        maxTokens: 2048,
        timeoutMs: 60_000,
      })
      return textResult({
        model: MODEL,
        answer,
        truncated,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return textResult({ error: `Worker model call failed: ${message}` })
    }
  },
)

server.registerTool(
  'list_worker_models',
  {
    description:
      'List available 1-slot Featherless models (concurrencyCost <= 1) that support tool use. ' +
      'Useful for finding alternative worker models. Requires CLINE_WORKER_API_KEY.',
  },
  async () => {
    if (!API_KEY) {
      return textResult({
        error: 'CLINE_WORKER_API_KEY is not set in .env.',
      })
    }

    const params = new URLSearchParams()
    params.set('per_page', '200')
    params.set('available_on_current_plan', 'true')

    try {
      const res = await fetch(`${FEATHERLESS_BASE_URL}/models?${params.toString()}`, {
        headers: {
          'User-Agent': FEATHERLESS_USER_AGENT,
          Authorization: `Bearer ${API_KEY}`,
        },
      })
      if (!res.ok) {
        return textResult({ error: `Featherless API returned ${res.status}: ${await res.text()}` })
      }
      const data = (await res.json()) as {
        data: Array<{
          id: string
          concurrency_cost?: number
          features?: { tool_use?: boolean }
          context_length?: number
        }>
      }
      const cheap = data.data
        .filter((m) => (m.concurrency_cost ?? 4) <= 1)
        .map((m) => ({
          id: m.id,
          contextLength: m.context_length,
          toolUse: m.features?.tool_use ?? false,
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
      return textResult({
        currentModel: MODEL,
        availableModels: cheap,
        count: cheap.length,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return textResult({ error: `Failed to list models: ${message}` })
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
