import { useEffect, useState } from "react";
import { createStory, fetchPhase, listStories, renameStory, type Story } from "./api";
import type { PanelProps } from "./panel-types";
import "./SavesView.css";

export default function SavesView({ story, onStoryChange, onPhaseChange }: PanelProps) {
  const [stories, setStories] = useState<Story[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setStories(await listStories());
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleSwitch(target: Story) {
    onStoryChange(target);
    onPhaseChange((await fetchPhase(target.id)).phase);
  }

  async function handleRename(id: string) {
    if (!renameDraft.trim()) return;
    try {
      await renameStory(id, renameDraft.trim());
      setRenamingId(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      const created = await createStory(newName.trim());
      setNewName("");
      await reload();
      await handleSwitch(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function parentName(parentId: string | null): string | null {
    if (!parentId) return null;
    return stories.find((s) => s.id === parentId)?.name ?? "(unknown)";
  }

  return (
    <div className="saves-view">
      <h2>Saves</h2>
      {error && <div className="error-banner">{error}</div>}

      <form
        className="saves-new-form"
        onSubmit={(e) => {
          e.preventDefault();
          void handleCreate();
        }}
      >
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New story name" />
        <button type="submit">+ New story</button>
      </form>

      <ul className="saves-list">
        {stories.map((s) => (
          <li key={s.id} className={s.id === story?.id ? "active" : ""}>
            {renamingId === s.id ? (
              <>
                <input value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} />
                <button type="button" onClick={() => handleRename(s.id)}>
                  Save
                </button>
                <button type="button" onClick={() => setRenamingId(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <div className="saves-row-main">
                  <strong>{s.name}</strong>
                  {s.id === story?.id && <span className="current-badge">current</span>}
                  {parentName(s.parentStoryId) && (
                    <span className="fork-note">forked from {parentName(s.parentStoryId)}</span>
                  )}
                </div>
                <div className="saves-row-actions">
                  <button type="button" onClick={() => handleSwitch(s)} disabled={s.id === story?.id}>
                    Switch
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingId(s.id);
                      setRenameDraft(s.name);
                    }}
                  >
                    Rename
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
