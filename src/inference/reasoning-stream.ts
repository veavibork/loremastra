/**
 * Splits a streamed completion into reasoning vs answer text. DeepSeek-style models on
 * Featherless usually emit thinking inside `<think>` in `delta.content` (not
 * `reasoning_content`), especially when the assistant turn is prefilled with an open block.
 */

const OPEN_TAGS = ["<think>"];
const CLOSE_TAGS = ["</think>"];

function findFirstTag(text: string, tags: readonly string[]): { index: number; tag: string } | null {
  let best: { index: number; tag: string } | null = null;
  for (const tag of tags) {
    const index = text.indexOf(tag);
    if (index !== -1 && (best === null || index < best.index)) {
      best = { index, tag };
    }
  }
  return best;
}

/** Longest suffix of `text` that is a proper prefix of any tag (incomplete tag at chunk boundary). */
function partialTagHold(text: string, tags: readonly string[]): number {
  let hold = 0;
  for (const tag of tags) {
    for (let len = 1; len < tag.length; len++) {
      if (tag.startsWith(text.slice(-len))) {
        hold = Math.max(hold, len);
      }
    }
  }
  return hold;
}

export interface ReasoningStreamSplitterOptions {
  /** Request prefilled `<think>\\n` — first streamed tokens are reasoning. */
  startsInThinking?: boolean;
}

export class ReasoningStreamSplitter {
  private mode: "thinking" | "answer";
  private carry = "";

  constructor(options?: ReasoningStreamSplitterOptions) {
    this.mode = options?.startsInThinking ? "thinking" : "answer";
  }

  push(chunk: string, emitThinking: (text: string) => void, emitAnswer: (text: string) => void): void {
    if (!chunk) return;
    this.carry += chunk;
    this.drain(emitThinking, emitAnswer);
  }

  flush(emitThinking: (text: string) => void, emitAnswer: (text: string) => void): void {
    if (!this.carry) return;
    if (this.mode === "thinking") emitThinking(this.carry);
    else emitAnswer(this.carry);
    this.carry = "";
  }

  private drain(emitThinking: (text: string) => void, emitAnswer: (text: string) => void): void {
    while (this.carry.length > 0) {
      if (this.mode === "thinking") {
        const close = findFirstTag(this.carry, CLOSE_TAGS);
        if (close) {
          const before = this.carry.slice(0, close.index);
          if (before) emitThinking(before);
          this.carry = this.carry.slice(close.index + close.tag.length);
          this.mode = "answer";
          continue;
        }
        const hold = partialTagHold(this.carry, CLOSE_TAGS);
        const emitLen = this.carry.length - hold;
        if (emitLen <= 0) break;
        emitThinking(this.carry.slice(0, emitLen));
        this.carry = this.carry.slice(emitLen);
        continue;
      }

      const open = findFirstTag(this.carry, OPEN_TAGS);
      if (open) {
        const before = this.carry.slice(0, open.index);
        if (before) emitAnswer(before);
        this.carry = this.carry.slice(open.index + open.tag.length);
        this.mode = "thinking";
        continue;
      }
      const hold = partialTagHold(this.carry, OPEN_TAGS);
      const emitLen = this.carry.length - hold;
      if (emitLen <= 0) break;
      emitAnswer(this.carry.slice(0, emitLen));
      this.carry = this.carry.slice(emitLen);
    }
  }
}

/** Conservative TTFT guess for hosted prefill — intentionally high so early tokens feel like a win. */
export function estimatePrefillSeconds(inputTokens: number): number {
  if (inputTokens <= 0) return 30;
  return Math.max(10, Math.min(120, Math.ceil(inputTokens / 200)));
}
