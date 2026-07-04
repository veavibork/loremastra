import { useCallback, useEffect, useState } from "react";
import { fetchPromptPreview, type PromptMessage, type PromptPreview } from "./api";
import { classifyPromptBlock, promptBlockLabel } from "./prompt-block";
import type { PanelProps } from "./panel-types";
import "./PromptMessage.css";
import "./MemoryView.css";

/** Polls while open — archives and worldbook can change in the background with no local action to refresh from. */
const POLL_MS = 3000;

function messageClass(m: PromptMessage): string {
  const kind = classifyPromptBlock(m.content, m.role);
  if (kind === "content" || kind === "roster" || kind === "memory" || kind === "story-to-date" || kind === "event-summary") {
    return `prompt-message prompt-block-${kind}`;
  }
  return `prompt-message prompt-message-${m.role}`;
}

function formatHeaderMeta(m: PromptMessage, label: string): string {
  const parts = [label, `${m.tokenEstimate.toLocaleString()} tok`];
  if (m.icPostNumber != null) parts.push(`post ${m.icPostNumber}`);
  parts.push(`Σ ${m.cumulativeTokens.toLocaleString()}`);
  return parts.join(" · ");
}

export default function MemoryView({ story }: PanelProps) {
  const storyId = story?.id;
  const [preview, setPreview] = useState<PromptPreview | null>(null);

  const reload = useCallback(
    async (opts?: { background?: boolean }) => {
      if (!storyId) return;
      setPreview(await fetchPromptPreview(storyId, opts));
    },
    [storyId]
  );

  useEffect(() => {
    if (!storyId) return;
    void reload();
    const interval = setInterval(() => void reload({ background: true }), POLL_MS);
    return () => clearInterval(interval);
  }, [storyId, reload]);

  if (!story) return <div className="memory-view">No active story.</div>;

  const messages = preview?.messages ?? [];

  return (
    <div className="memory-view">
      <h2>Memory</h2>
      <p className="memory-note">
        Read-only Author prompt at the current position — worldbook, [STORY TO DATE], then verbose IC
        prose. Token counts use the same ~4 chars/token estimate as the story-to-date trigger. Refreshes
        every few seconds.
      </p>
      {preview && (
        <p className="memory-budget-bar">
          <span>
            Total <strong>{preview.totalTokens.toLocaleString()}</strong> tok
          </span>
          <span>
            Usable budget <strong>{preview.usableBudget.toLocaleString()}</strong> tok
          </span>
          <span>
            Archive trigger <strong>{preview.storyToDateTriggerAt.toLocaleString()}</strong> tok (80%)
          </span>
          {preview.totalTokens >= preview.storyToDateTriggerAt && (
            <span className="memory-budget-over">≥ archive threshold</span>
          )}
        </p>
      )}

      {messages.map((m, i) => {
        const kind = classifyPromptBlock(m.content, m.role);
        const label = kind === "user" || kind === "assistant" || kind === "system" ? m.role : promptBlockLabel(kind);
        return (
          <div key={i} className={messageClass(m)}>
            <span className="prompt-message-role">{formatHeaderMeta(m, label)}</span>
            <p>{m.content}</p>
          </div>
        );
      })}
    </div>
  );
}
