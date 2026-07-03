import type { ReactNode } from "react";
import { WORLDBOOK_BLOCK_PATTERN } from "./worldbookBlocks";

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
const INLINE_PATTERN = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let i = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    if (match.index! > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    if (match[1] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-${i++}`}>{match[1]}</strong>);
    } else {
      nodes.push(<em key={`${keyPrefix}-${i++}`}>{match[2]}</em>);
    }
    lastIndex = match.index! + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export default function EntryContent({ content, highlightBlocks }: { content: string; highlightBlocks?: boolean }) {
  if (!highlightBlocks) {
    return <div className="entry-content">{renderInline(content, "i")}</div>;
  }

  const segments: { text: string; type: string | null }[] = [];
  let lastIndex = 0;
  for (const match of content.matchAll(WORLDBOOK_BLOCK_PATTERN)) {
    if (match.index! > lastIndex) segments.push({ text: content.slice(lastIndex, match.index), type: null });
    segments.push({ text: match[0], type: match[1].toLowerCase() });
    lastIndex = match.index! + match[0].length;
  }
  if (lastIndex < content.length) segments.push({ text: content.slice(lastIndex), type: null });

  return (
    <div className="entry-content">
      {segments.map((seg, i) =>
        seg.type ? (
          <mark key={i} className={`worldbook-block worldbook-block-${seg.type}`}>
            {renderInline(seg.text, `m${i}`)}
          </mark>
        ) : (
          <span key={i}>{renderInline(seg.text, `s${i}`)}</span>
        )
      )}
    </div>
  );
}
