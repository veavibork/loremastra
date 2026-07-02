import { useEffect, useState } from "react";
import { fetchPromptPreview, fetchTags, type PromptMessage, type Tag } from "./api";
import type { PanelProps } from "./panel-types";
import "./PromptInspectorView.css";
import "./MemoryView.css";

export default function MemoryView({ story }: PanelProps) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [activeTagIds, setActiveTagIds] = useState<string[]>([]);
  const [messages, setMessages] = useState<PromptMessage[]>([]);

  useEffect(() => {
    if (!story) return;
    setActiveTagIds([]);
    void fetchTags(story.id).then((all) => setTags(all.filter((t) => !t.hidden)));
  }, [story]);

  useEffect(() => {
    if (!story) return;
    void fetchPromptPreview(story.id, activeTagIds).then(setMessages);
  }, [story, activeTagIds]);

  function toggleTag(id: string) {
    setActiveTagIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  }

  if (!story) return <div className="memory-view">No active story.</div>;

  return (
    <div className="memory-view">
      <h2>Memory</h2>
      <p className="memory-note">
        Simulates which tags are "active" on the triggering post, independent of what actually happened in
        the story — click a tag to see how the prompt assembler reacts to its presence. With nothing
        selected, this is the zero-keyword-match baseline: just the always-included Setting/Register/PC and
        recent history, no tag-triggered worldbook entries or promoted lines.
      </p>
      <div className="memory-tag-row">
        {tags.length === 0 && <span className="memory-note">No tags yet.</span>}
        {tags.map((tag) => (
          <button
            key={tag.id}
            type="button"
            className={`memory-tag-bubble ${activeTagIds.includes(tag.id) ? "active" : ""}`}
            onClick={() => toggleTag(tag.id)}
          >
            {tag.name}
          </button>
        ))}
      </div>

      {messages.map((m, i) => (
        <div key={i} className={`prompt-message prompt-message-${m.role}`}>
          <span className="prompt-message-role">{m.role}</span>
          <p>{m.content}</p>
        </div>
      ))}
    </div>
  );
}
