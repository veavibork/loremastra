import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import { WORLDBOOK_BLOCK_PATTERN } from "./worldbookBlocks";

/**
 * Shared renderer for post/reply content — single newlines still break like the old pre-wrap
 * <p> did, via remark-breaks. When `highlightBlocks` is set (OOC/Guide mode), any
 * [CONTENT]/[ROSTER]/[MEMORY] span gets wrapped in a highlighted <mark> so the player can see
 * in advance what's about to become a worldbook entry — bracket tags stay visible inside the
 * mark rather than stripped, to make it unambiguous exactly which text triggers extraction.
 */
export default function EntryContent({ content, highlightBlocks }: { content: string; highlightBlocks?: boolean }) {
  if (!highlightBlocks) {
    return (
      <div className="entry-content">
        <ReactMarkdown remarkPlugins={[remarkBreaks]}>{content}</ReactMarkdown>
      </div>
    );
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
            <ReactMarkdown remarkPlugins={[remarkBreaks]}>{seg.text}</ReactMarkdown>
          </mark>
        ) : (
          <ReactMarkdown key={i} remarkPlugins={[remarkBreaks]}>
            {seg.text}
          </ReactMarkdown>
        )
      )}
    </div>
  );
}
