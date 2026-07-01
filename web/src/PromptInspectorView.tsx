import { useEffect, useState } from "react";
import { fetchPromptPreview, type PromptMessage } from "./api";
import type { PanelProps } from "./panel-types";
import "./PromptInspectorView.css";

export default function PromptInspectorView({ story }: PanelProps) {
  const [messages, setMessages] = useState<PromptMessage[]>([]);

  useEffect(() => {
    if (!story) return;
    void fetchPromptPreview(story.id).then(setMessages);
  }, [story]);

  if (!story) return <div className="prompt-inspector">No active story.</div>;

  return (
    <div className="prompt-inspector">
      <h2>Assembled Prompt</h2>
      <p className="prompt-inspector-note">
        What the Author would receive right now, at the current position — no inference call made.
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
