/**
 * Splits a streamed completion into reasoning vs answer text when the model emits explicit
 * thinking markers in `delta.content`. Do NOT assume thinking from assistant prefill alone —
 * on Featherless, DeepSeek-V4-Pro streams IC prose directly in `content` with no
 * `reasoning_content` and no close tag (see scripts/probe-deepseek-stream.ts, 2026-07-04).
 */

/** Default tag pair — the fallback for unprofiled models. A probed model's confirmed variant is added on top via ReasoningStreamSplitterOptions (see src/services/model-format.ts). */
export const DEFAULT_OPEN_TAGS = ['<think>']
export const DEFAULT_CLOSE_TAGS = ['</think>']

function findFirstTag(
  text: string,
  tags: readonly string[],
): { index: number; tag: string } | null {
  let best: { index: number; tag: string } | null = null
  for (const tag of tags) {
    const index = text.indexOf(tag)
    if (index !== -1 && (best === null || index < best.index)) {
      best = { index, tag }
    }
  }
  return best
}

/** Longest suffix of `text` that is a proper prefix of any tag (incomplete tag at chunk boundary). */
function partialTagHold(text: string, tags: readonly string[]): number {
  let hold = 0
  for (const tag of tags) {
    for (let len = 1; len < tag.length; len++) {
      if (tag.startsWith(text.slice(-len))) {
        hold = Math.max(hold, len)
      }
    }
  }
  return hold
}

export interface ReasoningStreamSplitterOptions {
  /** Only set true if the stream has already opened a thinking block — never infer from request prefill. */
  startsInThinking?: boolean
  /** Full open-tag list to watch for; defaults to DEFAULT_OPEN_TAGS. */
  openTags?: readonly string[]
  /** Full close-tag list to watch for; defaults to DEFAULT_CLOSE_TAGS. */
  closeTags?: readonly string[]
}

export class ReasoningStreamSplitter {
  private mode: 'thinking' | 'answer'
  private carry = ''
  private readonly openTags: readonly string[]
  private readonly closeTags: readonly string[]

  constructor(options?: ReasoningStreamSplitterOptions) {
    this.mode = options?.startsInThinking ? 'thinking' : 'answer'
    this.openTags = options?.openTags?.length ? options.openTags : DEFAULT_OPEN_TAGS
    this.closeTags = options?.closeTags?.length ? options.closeTags : DEFAULT_CLOSE_TAGS
  }

  push(
    chunk: string,
    emitThinking: (text: string) => void,
    emitAnswer: (text: string) => void,
  ): void {
    if (!chunk) return
    this.carry += chunk
    this.drain(emitThinking, emitAnswer)
  }

  flush(emitThinking: (text: string) => void, emitAnswer: (text: string) => void): void {
    if (!this.carry) return
    if (this.mode === 'thinking') emitThinking(this.carry)
    else emitAnswer(this.carry)
    this.carry = ''
  }

  private drain(emitThinking: (text: string) => void, emitAnswer: (text: string) => void): void {
    while (this.carry.length > 0) {
      if (this.mode === 'thinking') {
        const close = findFirstTag(this.carry, this.closeTags)
        if (close) {
          const before = this.carry.slice(0, close.index)
          if (before) emitThinking(before)
          this.carry = this.carry.slice(close.index + close.tag.length)
          this.mode = 'answer'
          continue
        }
        const hold = partialTagHold(this.carry, this.closeTags)
        const emitLen = this.carry.length - hold
        if (emitLen <= 0) break
        emitThinking(this.carry.slice(0, emitLen))
        this.carry = this.carry.slice(emitLen)
        continue
      }

      const open = findFirstTag(this.carry, this.openTags)
      if (open) {
        const before = this.carry.slice(0, open.index)
        if (before) emitAnswer(before)
        this.carry = this.carry.slice(open.index + open.tag.length)
        this.mode = 'thinking'
        continue
      }
      const hold = partialTagHold(this.carry, this.openTags)
      const emitLen = this.carry.length - hold
      if (emitLen <= 0) break
      emitAnswer(this.carry.slice(0, emitLen))
      this.carry = this.carry.slice(emitLen)
    }
  }
}

/** Conservative TTFT guess for hosted prefill — intentionally high so early tokens feel like a win. */
export function estimatePrefillSeconds(inputTokens: number): number {
  if (inputTokens <= 0) return 30
  return Math.max(10, Math.min(120, Math.ceil(inputTokens / 200)))
}

/**
 * Strips `<think>...</think>` block(s) from a complete (non-streamed) reply — for `completeChat`/
 * `callWithTools` callers, which read `message.content` directly with no `ReasoningStreamSplitter`
 * to separate reasoning from answer live (confirmed live on Featherless: Qwen3 puts reasoning
 * inline in `content` with no separate field at all, see docs/providers/model-shape-probe-2026-07-17.md).
 * An unclosed trailing `<think>` (the model spent its whole budget still thinking, never reached a
 * real answer) drops everything from that point on, same as if the model had produced no content.
 */
export function stripThinkingTags(text: string): string {
  let result = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const openIndex = result.search(/<think>/i)
  if (openIndex !== -1) result = result.slice(0, openIndex)
  return result.trim()
}
