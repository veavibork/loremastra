import { memo, type ReactNode } from 'react'
import { WORLDBOOK_BLOCK_PATTERN } from './worldbookBlocks'

/**
 * Shared renderer for post/reply content — KoboldAI-Lite style: content renders in a
 * `white-space: pre-wrap` container with only *inline* formatting substitution (bold/italic),
 * never block-level splitting. A blank line in the source is a blank line on screen, exactly
 * like a plain <textarea> renders it — this is what keeps edit mode (StoryView.tsx's
 * edit-box-textarea, same font/line-height, same pre-wrap-by-default textarea behavior) visually
 * identical to read mode. Deliberately not a real Markdown renderer: block elements (headers,
 * lists, etc.) would reintroduce the margin-vs-blank-line mismatch this replaced ReactMarkdown to
 * avoid. When `highlightBlocks` is set (OOC/Guide mode), any [CONTENT]/[ROSTER]/[MEMORY] span
 * gets wrapped in a highlighted <mark> so the player can see in advance what's about to become a
 * worldbook entry — bracket tags stay visible inside the mark rather than stripped, to make it
 * unambiguous exactly which text triggers extraction.
 */
const INLINE_PATTERN = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g

/**
 * `base` is this run's starting offset in the *original* source string (not the rendered text) —
 * every generated node carries it as data-src-start so StoryView.tsx's tap-to-edit can map a
 * click's pixel position (via caretRangeFromPoint) back to a source-string offset even though
 * bold/italic markers are stripped from what's actually rendered.
 */
function renderInline(text: string, keyPrefix: string, base: number): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  for (const match of text.matchAll(INLINE_PATTERN)) {
    if (match.index! > lastIndex) {
      nodes.push(
        <span key={`${keyPrefix}-t${lastIndex}`} data-src-start={base + lastIndex}>
          {text.slice(lastIndex, match.index)}
        </span>,
      )
    }
    if (match[1] !== undefined) {
      nodes.push(
        <strong
          key={`${keyPrefix}-${match.index}`}
          data-src-start={base + match.index! + 2 /* skip opening "**" */}
        >
          {match[1]}
        </strong>,
      )
    } else {
      nodes.push(
        <em
          key={`${keyPrefix}-${match.index}`}
          data-src-start={base + match.index! + 1 /* skip opening "*" */}
        >
          {match[2]}
        </em>,
      )
    }
    lastIndex = match.index! + match[0].length
  }
  if (lastIndex < text.length) {
    nodes.push(
      <span key={`${keyPrefix}-t${lastIndex}`} data-src-start={base + lastIndex}>
        {text.slice(lastIndex)}
      </span>,
    )
  }
  return nodes
}

function EntryContent({
  content,
  highlightBlocks,
}: {
  content: string
  highlightBlocks?: boolean
}) {
  if (!highlightBlocks) {
    return <div className="entry-content">{renderInline(content, 'i', 0)}</div>
  }

  const segments: { text: string; type: string | null; start: number }[] = []
  let lastIndex = 0
  for (const match of content.matchAll(WORLDBOOK_BLOCK_PATTERN)) {
    if (match.index! > lastIndex)
      segments.push({ text: content.slice(lastIndex, match.index), type: null, start: lastIndex })
    segments.push({ text: match[0], type: match[1].toLowerCase(), start: match.index! })
    lastIndex = match.index! + match[0].length
  }
  if (lastIndex < content.length)
    segments.push({ text: content.slice(lastIndex), type: null, start: lastIndex })

  return (
    <div className="entry-content">
      {segments.map((seg, i) =>
        seg.type ? (
          <mark key={i} className={`worldbook-block worldbook-block-${seg.type}`}>
            {renderInline(seg.text, `m${i}`, seg.start)}
          </mark>
        ) : (
          <span key={i}>{renderInline(seg.text, `s${i}`, seg.start)}</span>
        ),
      )}
    </div>
  )
}

// StoryView re-renders the whole log on every streamed token (pendingReplies changes) or click
// (tap-to-edit uses event delegation on the .log container, not a per-entry onClick prop, so
// this component never takes a non-primitive prop that would defeat the comparison below).
// content/highlightBlocks are plain string/boolean, so the default shallow-equal check is enough
// to skip the regex re-parse for every already-settled post that isn't the one actually changing.
export default memo(EntryContent)
