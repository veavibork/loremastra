/**
 * Shared naming helpers — [NAME] block extraction and validation.
 * Used by both story-name and segment-name executors.
 */

const STORY_NAME_MAX_WORDS = 12 // generous ceiling for a 2-6 word title — catches "wrote a sentence instead" cases
const NAME_PATTERN = /\[NAME\]([\s\S]*?)\[\/NAME\]/i
const NAME_OPEN_PATTERN = /\[NAME\]\s*([^\n[]+)/i

function withinWordLimit(text: string, maxWords: number): boolean {
  return !!text && text.split(/\s+/).length <= maxWords
}

function isValidExtractedName(content: string): boolean {
  if (/<\|[^|>]*\|>/.test(content)) return false
  if (/:\s+\S/.test(content)) return false
  return withinWordLimit(content, STORY_NAME_MAX_WORDS)
}

export function extractStoryName(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  let content: string | null = null
  const closed = NAME_PATTERN.exec(trimmed)
  if (closed?.[1]) {
    content = closed[1].trim()
  } else {
    const open = NAME_OPEN_PATTERN.exec(trimmed)
    if (open?.[1]) content = open[1].trim()
  }

  if (!content) {
    const firstLine =
      trimmed
        .split(/\n/)
        .map((l) => l.trim())
        .find(Boolean) ?? ''
    const cleaned = firstLine
      .replace(/^(?:title|name|scene)\s*:\s*/i, '')
      .replace(/^\[NAME\]\s*/i, '')
      .replace(/^\*+|\*+$/g, '')
      .replace(/^["'`""'']+|["'`""'']+$/g, '')
      .trim()
    if (cleaned && !/[[\]]/.test(cleaned) && isValidExtractedName(cleaned)) {
      content = cleaned
    }
  }

  if (!content) return null
  content = content.replace(/^["'`""'']+|["'`""'']+$/g, '').trim()
  if (!isValidExtractedName(content)) return null
  return content
}

export const NAMING_MAX_TOKENS = 64
export const STORY_NAME_MAX_ATTEMPTS = 2
export const SEGMENT_NAME_MAX_ATTEMPTS = 3
