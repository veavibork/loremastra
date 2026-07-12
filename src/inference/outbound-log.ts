import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ChatMessage } from './featherless.js'

/**
 * Append-only JSON-lines log for inference calls + structured logging.
 * Written straight from the process (not stdout) because child_process redirection
 * has been observed to lose output on Windows.
 *
 * Best-effort: a logging failure must never break the actual inference call.
 */
const LOG_PATH = path.resolve(process.cwd(), 'data', 'outbound-requests.log')
const MAX_ENTRIES = 50
const MAX_LOG_BYTES = 512 * 1024

// -- Types --

interface OutboundLogEntry {
  at: string
  call: 'streamInference' | 'callWithTools' | 'completeChat'
  model: string
  messages: ChatMessage[]
  /** Response metadata — written after the call completes. */
  response?: OutboundResponse
}

export interface OutboundResponse {
  success: boolean
  latencyMs: number
  inputTokens: number
  outputTokens: number
  retries: number
  error?: string
}

export interface LogContext {
  storyId?: string
  jobId?: string
  jobType?: string
}

interface LogEntry {
  at: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  context: LogContext
  detail?: unknown
}

type LogLine = OutboundLogEntry | LogEntry

// -- File I/O --

function appendLine(obj: LogLine): void {
  try {
    const line = JSON.stringify(obj)
    if (!existsSync(LOG_PATH)) writeFileSync(LOG_PATH, '')
    appendFileSync(LOG_PATH, line + '\n')
    const size = statSync(LOG_PATH).size
    if (size > MAX_LOG_BYTES) trimLogFile()
  } catch {
    // Best-effort — never break the caller.
  }
}

function trimLogFile(): void {
  const lines = readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean)
  const trimmed = lines.slice(-MAX_ENTRIES)
  writeFileSync(LOG_PATH, trimmed.join('\n') + (trimmed.length ? '\n' : ''))
}

// -- Public API --

export function logOutboundRequest(entry: Omit<OutboundLogEntry, 'at'>): void {
  appendLine({ at: new Date().toISOString(), ...entry })
}

export function logOutboundResponse(
  call: OutboundLogEntry['call'],
  model: string,
  response: OutboundResponse,
): void {
  appendLine({ at: new Date().toISOString(), call, model, messages: [], response })
}

export function readRecentOutboundRequests(limit?: number): OutboundLogEntry[] {
  if (!existsSync(LOG_PATH)) return []
  const lines = readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean)
  const scoped = limit ? lines.slice(-limit) : lines
  return scoped.map((line) => JSON.parse(line) as OutboundLogEntry).filter((e) => 'call' in e)
}

/**
 * Context-aware logger — every line auto-stamps storyId/jobId/jobType.
 * Use in pipeline-runner and services for grep-able structured output.
 */
export function createLogger(context: LogContext = {}) {
  return {
    info(message: string, detail?: unknown) {
      appendLine({ at: new Date().toISOString(), level: 'info', message, context, detail })
    },
    warn(message: string, detail?: unknown) {
      appendLine({ at: new Date().toISOString(), level: 'warn', message, context, detail })
    },
    error(message: string, detail?: unknown) {
      appendLine({ at: new Date().toISOString(), level: 'error', message, context, detail })
    },
    debug(message: string, detail?: unknown) {
      appendLine({ at: new Date().toISOString(), level: 'debug', message, context, detail })
    },
    child(extra: LogContext) {
      return createLogger({ ...context, ...extra })
    },
  }
}
