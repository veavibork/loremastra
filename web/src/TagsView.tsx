import { useEffect, useState } from "react";
import { createTag, fetchTags, updateTag, type Tag } from "./api";
import type { PanelProps } from "./panel-types";
import "./TagsView.css";

/** Polls on a short interval — tags can change in the background during Setup's live worldbook extraction, with no local action to hook a one-off refresh onto. */
const POLL_MS = 3000;

export default function TagsView({ story }: PanelProps) {
  const storyId = story?.id;
  const [tags, setTags] = useState<Tag[]>([]);
  const [newTagName, setNewTagName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function reload(opts?: { background?: boolean }) {
    if (!storyId) return;
    setTags(await fetchTags(storyId, opts));
  }

  useEffect(() => {
    void reload();
    const interval = setInterval(() => void reload({ background: true }), POLL_MS);
    return () => clearInterval(interval);
  }, [storyId]);

  async function submitNewTag(e: React.FormEvent) {
    e.preventDefault();
    if (!storyId || !newTagName.trim()) return;
    try {
      await createTag(storyId, newTagName.trim());
      setNewTagName("");
      await reload();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function renameTag(tag: Tag, name: string) {
    if (!storyId || name === tag.name) return;
    try {
      await updateTag(storyId, tag.id, { name });
      await reload();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleTagHidden(tag: Tag) {
    if (!storyId) return;
    await updateTag(storyId, tag.id, { hidden: !tag.hidden });
    await reload();
  }

  if (!storyId) return <div className="tags-view">No active story.</div>;

  return (
    <div className="tags-view">
      <h2>Tags</h2>
      <p className="tags-note">
        Tags aren't attached to anything — they're purely grepped against post and worldbook
        content, live. A tag matches whatever mentions it (letters only, at least 3 characters).
      </p>
      {error && <div className="error-banner">{error}</div>}
      <form onSubmit={submitNewTag} className="tag-new-form">
        <input value={newTagName} onChange={(e) => setNewTagName(e.target.value)} placeholder="newtag" />
        <button type="submit">Add</button>
      </form>
      <ul className="tag-list">
        {tags.map((tag) => (
          <li key={tag.id} className={tag.hidden ? "tag-hidden" : ""}>
            <input className="tag-name-input" defaultValue={tag.name} onBlur={(e) => renameTag(tag, e.target.value.trim())} />
            <button type="button" onClick={() => toggleTagHidden(tag)}>
              {tag.hidden ? "unhide" : "hide"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
