import { useEffect, useState } from "react";
import { fetchPromptPreview, type PromptMessage } from "./api";
import type { PanelProps } from "./panel-types";
import "./PromptMessage.css";
import "./MemoryView.css";

export default function MemoryView({ story }: PanelProps) {
  const [messages, setMessages] = useState<PromptMessage[]>([]);

  useEffect(() => {
    if (!story) return;
    void fetchPromptPreview(story.id).then(setMessages);
  }, [story]);

  if (!story) return <div className="memory-view">No active story.</div>;

  return (
    <div className="memory-view">
      <h2>Memory</h2>
      <p className="memory-note">
        Read-only preview of the assembled Author prompt at the current position. Full worldbook entries
        are always included; recent posts appear as verbose prose; older history appears as [EVENT SUMMARY]
        archive blocks when over budget.
      </p>

      {messages.map((m, i) => (
        <div key={i} className={`prompt-message prompt-message-${m.role}`}>
          <span className="prompt-message-role">{m.role}</span>
          <p>{m.content}</p>
        </div>
      ))}
    </div>
  );
}
