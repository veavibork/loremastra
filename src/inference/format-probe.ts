/**
 * Model format probe engine — step 3 of docs/providers/format-probe-plan.md.
 *
 * Given a (provider, model) pair, runs a small matrix of raw streaming calls and tests the
 * hypothesis corpus (src/data/format-hypotheses.ts) against what actually comes back:
 * which delta field carries reasoning, which inline thinking-tag variant (if any) appears,
 * whether the thinking kwargs are honored in BOTH directions, whether thinking_budget
 * bounds anything, which template tokens leak, and whether finish_reason can be trusted.
 *
 * Probe = the map; shape-based runtime routing stays the safety net. Every condition runs
 * n>=2 times (single-run probes lie — src/inference/schema/README.md gotchas), calls are
 * sequential (big models eat concurrency; parallel probes just 429), and raw SSE payloads
 * are kept as evidence when an artifact dir is given.
 *
 * This module is a library: no job/queue coupling (that's step 4). Manual harness:
 * scripts/format-probe.ts.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FEATHERLESS_BASE_URL, FEATHERLESS_USER_AGENT } from './featherless-config.js'
import {
  LEAK_TOKEN_HYPOTHESES,
  THINKING_TAG_HYPOTHESES,
  allLeakScanTokens,
  familyForModelId,
} from '../data/format-hypotheses.js'

// ---------------------------------------------------------------------------
// Types

export const PROBE_CONDITION_IDS = [
  'baseline',
  'thinking-off',
  'thinking-on',
  'thinking-budget',
] as const
export type ProbeConditionId = (typeof PROBE_CONDITION_IDS)[number]

/** Exact kwargs per condition — the probe controls the request precisely, no defaults layered in. */
export const PROBE_CONDITION_KWARGS: Record<ProbeConditionId, Record<string, unknown> | undefined> =
  {
    baseline: undefined,
    'thinking-off': { enable_thinking: false, thinking: false },
    'thinking-on': { enable_thinking: true, thinking: true },
    'thinking-budget': { enable_thinking: true, thinking: true, thinking_budget: 64 },
  }

export interface ProbeObservation {
  condition: ProbeConditionId
  run: number
  ok: boolean
  httpStatus: number
  error?: string
  /** Non-null delta keys seen, with occurrence counts. */
  deltaKeys: Record<string, number>
  content: string
  reasoningField: string
  reasoningFieldName: 'reasoning' | 'reasoning_content' | 'thinking' | null
  finishReason: string | null
  elapsedMs: number
}

export interface InlineTagMatch {
  open: string
  close: string
  closed: boolean
}

export type ProbeShape = 'separate-field' | 'inline-tagged' | 'none-observed'

export interface ModelFormatProfile {
  provider: 'featherless'
  modelId: string
  probedAt: string
  family: string | null
  reasoningFieldName: 'reasoning' | 'reasoning_content' | 'thinking' | null
  inlineThinkingTag: { open: string; close: string } | null
  /** Union across all conditions (field evidence wins over tags). */
  shape: ProbeShape
  /**
   * Shape observed per condition — NOT a per-model constant. Confirmed live (Qwen3-8B,
   * 2026-07-19): no kwargs → inline <think> tags in content; explicit enable_thinking:true →
   * reasoning moves to the separate field. Consumers should read the condition matching how
   * they actually call (production always sends kwargs via resolveChatTemplateKwargs).
   */
  shapeByCondition: Partial<Record<ProbeConditionId, ProbeShape>>
  /** Content under thinking-on grew with no observable reasoning anywhere — GLM-style shape C. */
  unmarkedReasoningSuspected: boolean
  thinkingOffSuppresses: boolean | null
  thinkingOnProduces: boolean | null
  thinkingBudgetHonored: boolean | null
  leakTokensSeen: string[]
  finishReasonReliable: boolean
  sane: boolean
  saneReasons: string[]
  callsAttempted: number
  callsSucceeded: number
  notes: string[]
}

// ---------------------------------------------------------------------------
// Pure analysis helpers (unit-tested in tests/services/format-probe.test.ts)

/** First corpus tag whose open marker appears in the text (any spelling). */
export function detectInlineTag(content: string): InlineTagMatch | null {
  for (const hyp of THINKING_TAG_HYPOTHESES) {
    for (const open of hyp.open) {
      const openIdx = content.indexOf(open)
      if (openIdx === -1) continue
      const closed = content.indexOf(hyp.close, openIdx + open.length) !== -1
      return { open, close: hyp.close, closed }
    }
  }
  return null
}

/**
 * Removes matched thinking block(s); an unclosed open drops everything after it — same
 * philosophy as stripThinkingTags() in reasoning-stream.ts.
 */
export function stripInlineThinking(content: string, match: InlineTagMatch): string {
  let result = content
  for (;;) {
    const openIdx = result.indexOf(match.open)
    if (openIdx === -1) break
    const closeIdx = result.indexOf(match.close, openIdx + match.open.length)
    if (closeIdx === -1) {
      result = result.slice(0, openIdx)
      break
    }
    result = result.slice(0, openIdx) + result.slice(closeIdx + match.close.length)
  }
  return result.trim()
}

/** Template tokens found in answer text (thinking blocks should be stripped first). */
export function scanLeakTokens(text: string): string[] {
  const found: string[] = []
  for (const token of allLeakScanTokens()) {
    if (text.includes(token)) found.push(token)
  }
  return found
}

/**
 * Cheap coherence check for a probe reply (after thinking is stripped). Catches broken
 * server-side templates (empty output, token soup) — not a quality judgment.
 */
export function assessSanity(cleanContent: string): { sane: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (cleanContent.length < 40) reasons.push(`only ${cleanContent.length} chars of answer text`)
  const words = cleanContent.split(/\s+/).filter((w) => w.length > 0)
  if (words.length < 8) reasons.push(`only ${words.length} words`)
  if (cleanContent.includes('�')) reasons.push('contains U+FFFD replacement characters')
  const leakChars = scanLeakTokens(cleanContent).reduce((n, t) => {
    let count = 0
    for (let i = cleanContent.indexOf(t); i !== -1; i = cleanContent.indexOf(t, i + t.length)) {
      count++
    }
    return n + count * t.length
  }, 0)
  if (cleanContent.length > 0 && leakChars / cleanContent.length > 0.3) {
    reasons.push('over 30% of the text is template tokens')
  }
  return { sane: reasons.length === 0, reasons }
}

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

/** Observable reasoning chars in one observation: separate field, or inside an inline tag block. */
function reasoningEvidenceChars(obs: ProbeObservation): number {
  if (obs.reasoningField.length > 0) return obs.reasoningField.length
  const tag = detectInlineTag(obs.content)
  if (!tag) return 0
  return obs.content.length - stripInlineThinking(obs.content, tag).length
}

export function aggregateProfile(
  modelId: string,
  observations: ProbeObservation[],
): ModelFormatProfile {
  const notes: string[] = []
  const ok = observations.filter((o) => o.ok)
  const byCondition = (id: ProbeConditionId) => ok.filter((o) => o.condition === id)

  // Reasoning field name: majority of non-null observations; conflicts are worth a note.
  const fieldNames = ok.map((o) => o.reasoningFieldName).filter((n) => n !== null)
  const fieldNameCounts = new Map<string, number>()
  for (const n of fieldNames) fieldNameCounts.set(n, (fieldNameCounts.get(n) ?? 0) + 1)
  const reasoningFieldName =
    ([...fieldNameCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] as
      ProbeObservation['reasoningFieldName'] | undefined) ?? null
  if (fieldNameCounts.size > 1) {
    notes.push(`conflicting reasoning field names seen: ${[...fieldNameCounts.keys()].join(', ')}`)
  }

  // Inline tag: first match across observations (field-carrying models won't have one).
  let inlineTagMatch: InlineTagMatch | null = null
  for (const o of ok) {
    const m = detectInlineTag(o.content)
    if (m) {
      inlineTagMatch = m
      if (!m.closed) notes.push(`inline ${m.open} block was never closed in at least one run`)
      break
    }
  }

  const anyField = ok.some((o) => o.reasoningField.length > 0)
  const shape: ProbeShape = anyField
    ? 'separate-field'
    : inlineTagMatch
      ? 'inline-tagged'
      : 'none-observed'

  const shapeByCondition: Partial<Record<ProbeConditionId, ProbeShape>> = {}
  for (const id of PROBE_CONDITION_IDS) {
    const group = byCondition(id)
    if (!group.length) continue
    shapeByCondition[id] = group.some((o) => o.reasoningField.length > 0)
      ? 'separate-field'
      : group.some((o) => detectInlineTag(o.content))
        ? 'inline-tagged'
        : 'none-observed'
  }
  if (anyField && inlineTagMatch) {
    notes.push(
      'shape depends on kwargs: reasoning field under some conditions, inline tags under ' +
        'others — see shapeByCondition',
    )
  }

  const onRuns = byCondition('thinking-on')
  const offRuns = byCondition('thinking-off')
  const budgetRuns = byCondition('thinking-budget')

  const thinkingOnProduces = onRuns.length
    ? onRuns.some((o) => reasoningEvidenceChars(o) > 0)
    : null

  let thinkingOffSuppresses: boolean | null = null
  if (offRuns.length) {
    const leaky = offRuns.filter((o) => reasoningEvidenceChars(o) > 0)
    thinkingOffSuppresses = leaky.length === 0
    if (leaky.length > 0 && leaky.length < offRuns.length) {
      notes.push(
        `thinking-off suppression is inconsistent (${leaky.length}/${offRuns.length} runs still produced reasoning)`,
      )
    }
  }

  // Budget honored: reasoning under a tiny budget should be meaningfully shorter than unbounded.
  let thinkingBudgetHonored: boolean | null = null
  const onChars = onRuns.map(reasoningEvidenceChars).filter((n) => n > 0)
  const budgetChars = budgetRuns.map(reasoningEvidenceChars)
  if (onChars.length && budgetRuns.length && median(onChars) > 200) {
    const ratio = median(budgetChars) / median(onChars)
    thinkingBudgetHonored = ratio < 0.5 ? true : ratio > 0.8 ? false : null
    if (thinkingBudgetHonored === null)
      notes.push('thinking_budget result ambiguous (ratio 0.5–0.8)')
  }

  // Shape C suspicion: thinking-on grew content substantially with nothing observable.
  let unmarkedReasoningSuspected = false
  if (thinkingOnProduces === false && offRuns.length && onRuns.length) {
    const onLen = median(onRuns.map((o) => o.content.length))
    const offLen = median(offRuns.map((o) => o.content.length))
    if (offLen > 0 && onLen > offLen * 1.8) {
      unmarkedReasoningSuspected = true
      notes.push(
        `thinking-on content is ${(onLen / offLen).toFixed(1)}x longer than thinking-off with no ` +
          'observable reasoning — unmarked (shape C) reasoning suspected; keep thinking disabled',
      )
    }
  }

  // Leak scan: strip recognized thinking, then any surviving template token is a leak.
  const leakTokensSeen = new Set<string>()
  for (const o of ok) {
    const tag = detectInlineTag(o.content)
    const clean = tag ? stripInlineThinking(o.content, tag) : o.content
    for (const t of scanLeakTokens(clean)) leakTokensSeen.add(t)
  }

  const finishReasonReliable = ok.length > 0 && ok.every((o) => o.finishReason !== null)
  if (!finishReasonReliable && ok.length) {
    notes.push('finish_reason missing on some runs — do not trust it as a truncation signal here')
  }

  // Sanity from baseline runs (the production-like condition).
  const baselineRuns = byCondition('baseline')
  const saneReasons: string[] = []
  for (const o of baselineRuns) {
    const tag = detectInlineTag(o.content)
    const clean = tag ? stripInlineThinking(o.content, tag) : o.content
    const s = assessSanity(clean)
    if (!s.sane) saneReasons.push(`run ${o.run}: ${s.reasons.join('; ')}`)
  }
  const sane = baselineRuns.length > 0 && saneReasons.length === 0

  return {
    provider: 'featherless',
    modelId,
    probedAt: new Date().toISOString(),
    family: familyForModelId(modelId),
    reasoningFieldName,
    inlineThinkingTag: inlineTagMatch
      ? { open: inlineTagMatch.open, close: inlineTagMatch.close }
      : null,
    shape,
    shapeByCondition,
    unmarkedReasoningSuspected,
    thinkingOffSuppresses,
    thinkingOnProduces,
    thinkingBudgetHonored,
    leakTokensSeen: [...leakTokensSeen],
    finishReasonReliable,
    sane,
    saneReasons,
    callsAttempted: observations.length,
    callsSucceeded: ok.length,
    notes,
  }
}

// ---------------------------------------------------------------------------
// Raw streaming observation

/** Same fixture as scripts/probe-model-shapes.ts, kept for cross-run comparability. */
const PROBE_MESSAGES = [
  {
    role: 'system',
    content:
      'You are a fantasy RPG narrator. Write 2 short in-character paragraphs. No meta commentary.',
  },
  { role: 'user', content: 'The PC pushes open the tavern door and steps inside.' },
]

const PROBE_MAX_TOKENS = 500
const REASONING_FIELD_KEYS = ['reasoning', 'reasoning_content', 'thinking'] as const

async function observeOnce(
  modelId: string,
  apiKey: string,
  kwargs: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
  rawSink: (payload: string) => void,
): Promise<Omit<ProbeObservation, 'condition' | 'run'>> {
  const t0 = Date.now()
  const deltaKeys: Record<string, number> = {}
  let content = ''
  let reasoningField = ''
  let reasoningFieldName: ProbeObservation['reasoningFieldName'] = null
  let finishReason: string | null = null

  const res = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': FEATHERLESS_USER_AGENT,
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: PROBE_MESSAGES,
      temperature: 1,
      max_tokens: PROBE_MAX_TOKENS,
      stream: true,
      ...(kwargs ? { chat_template_kwargs: kwargs } : {}),
    }),
  })

  if (!res.ok || !res.body) {
    const bodyText = await res.text().catch(() => '')
    return {
      ok: false,
      httpStatus: res.status,
      error: bodyText.slice(0, 500),
      deltaKeys,
      content: '',
      reasoningField: '',
      reasoningFieldName: null,
      finishReason: null,
      elapsedMs: Date.now() - t0,
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
      rawSink(payload)
      if (payload === '[DONE]') continue
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>
        }
        const choice = parsed.choices?.[0]
        if (choice?.finish_reason) finishReason = choice.finish_reason
        const delta = choice?.delta
        if (!delta) continue
        for (const key of Object.keys(delta)) {
          if (delta[key] != null) deltaKeys[key] = (deltaKeys[key] ?? 0) + 1
        }
        if (typeof delta.content === 'string') content += delta.content
        for (const key of REASONING_FIELD_KEYS) {
          const v = delta[key]
          if (typeof v === 'string' && v.length) {
            reasoningField += v
            reasoningFieldName ??= key
          }
        }
      } catch {
        /* malformed SSE line — raw log has it */
      }
    }
  }

  return {
    ok: true,
    httpStatus: res.status,
    deltaKeys,
    content,
    reasoningField,
    reasoningFieldName,
    finishReason,
    elapsedMs: Date.now() - t0,
  }
}

// ---------------------------------------------------------------------------
// Engine

export interface FormatProbeOptions {
  apiKey: string
  signal?: AbortSignal
  onProgress?: (label: string) => void
  /** When set, raw SSE payloads and the profile are written here as evidence. */
  artifactDir?: string
  /** Runs per condition; below 2 is refused (single-run probes lie). Default 2. */
  runsPerCondition?: number
  interCallDelayMs?: number
}

/** 429 = someone (often the probe's own previous call) still holds slots; wait it out once. */
const RETRY_DELAY_MS: Record<number, number> = { 429: 45_000, 500: 10_000, 503: 10_000 }
const MAX_ATTEMPTS_PER_CALL = 3

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
}

export async function runFormatProbe(
  modelId: string,
  options: FormatProbeOptions,
): Promise<{ profile: ModelFormatProfile; observations: ProbeObservation[] }> {
  const runs = Math.max(2, options.runsPerCondition ?? 2)
  const delayMs = options.interCallDelayMs ?? 1500
  const rawLines: string[] = []
  const observations: ProbeObservation[] = []

  const totalCalls = PROBE_CONDITION_IDS.length * runs
  let call = 0
  for (const condition of PROBE_CONDITION_IDS) {
    for (let run = 1; run <= runs; run++) {
      call++
      options.onProgress?.(`Probe ${call}/${totalCalls}: ${condition} run ${run}…`)
      let obs: Omit<ProbeObservation, 'condition' | 'run'> | null = null
      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_CALL; attempt++) {
        options.signal?.throwIfAborted()
        try {
          obs = await observeOnce(
            modelId,
            options.apiKey,
            PROBE_CONDITION_KWARGS[condition],
            options.signal,
            (payload) => rawLines.push(JSON.stringify({ condition, run, payload })),
          )
        } catch (err) {
          if (options.signal?.aborted) throw err
          obs = {
            ok: false,
            httpStatus: 0,
            error: err instanceof Error ? err.message : String(err),
            deltaKeys: {},
            content: '',
            reasoningField: '',
            reasoningFieldName: null,
            finishReason: null,
            elapsedMs: 0,
          }
        }
        const retryDelay = obs.ok ? undefined : RETRY_DELAY_MS[obs.httpStatus]
        if (obs.ok || retryDelay === undefined || attempt === MAX_ATTEMPTS_PER_CALL) break
        options.onProgress?.(
          `Probe ${call}/${totalCalls}: ${condition} run ${run} got ${obs.httpStatus} — retrying in ${Math.round(retryDelay / 1000)}s…`,
        )
        await sleep(retryDelay, options.signal)
      }
      observations.push({ condition, run, ...obs! })
      if (call < totalCalls) await sleep(delayMs, options.signal)
    }
  }

  const profile = aggregateProfile(modelId, observations)

  if (options.artifactDir) {
    mkdirSync(options.artifactDir, { recursive: true })
    writeFileSync(join(options.artifactDir, 'raw.jsonl'), rawLines.join('\n') + '\n')
    writeFileSync(join(options.artifactDir, 'profile.json'), JSON.stringify(profile, null, 2))
    writeFileSync(
      join(options.artifactDir, 'observations.json'),
      JSON.stringify(
        observations.map((o) => ({
          ...o,
          content: o.content.slice(0, 2000),
          reasoningField: o.reasoningField.slice(0, 2000),
        })),
        null,
        2,
      ),
    )
  }

  return { profile, observations }
}

// Re-exported so profile consumers can reason about leak kinds without a second import.
export { LEAK_TOKEN_HYPOTHESES }
