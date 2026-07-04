import { useCallback, useEffect, useState } from "react";
import { fetchPromptPreview, type PromptMessage } from "./api";
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

export default function MemoryView({ story }: PanelProps) {
  const storyId = story?.id;
  const [messages, setMessages] = useState<PromptMessage[]>([]);

  const reload = useCallback(
    async (opts?: { background?: boolean }) => {
      if (!storyId) return;
      setMessages(await fetchPromptPreview(storyId, opts));
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

  return (
    <div className="memory-view">
      <h2>Memory</h2>
      <p className="memory-note">
        Read-only preview of the assembled Author prompt at the current position. Full worldbook,
        merged [STORY TO DATE] segments, then verbose prose after coverage. Refreshes every few seconds.
      </p>

      {messages.map((m, i) => {
        const kind = classifyPromptBlock(m.content, m.role);
        const label = kind === "user" || kind === "assistant" || kind === "system" ? m.role : promptBlockLabel(kind);
        return (
          <div key={i} className={messageClass(m)}>
            <span className="prompt-message-role">{label}</span>
            <p>{m.content}</p>
          </div>
        );
      })}
    </div>
  );
}
