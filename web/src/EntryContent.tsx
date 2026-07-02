import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";

/** Shared renderer for post/reply content — single newlines still break like the old pre-wrap <p> did, via remark-breaks. */
export default function EntryContent({ content }: { content: string }) {
  return (
    <div className="entry-content">
      <ReactMarkdown remarkPlugins={[remarkBreaks]}>{content}</ReactMarkdown>
    </div>
  );
}
