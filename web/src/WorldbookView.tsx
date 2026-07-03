import { useEffect, useState } from "react";
import {
  createWorldbookEntry,
  fetchWorldbook,
  updateWorldbookEntry,
  type WorldbookEntry,
  type WorldbookEntryType,
} from "./api";
import EntryContent from "./EntryContent";
import type { PanelProps } from "./panel-types";
import "./WorldbookView.css";

const ENTRY_TYPES: WorldbookEntryType[] = ["content", "roster", "memory"];

/** Polls on a short interval — entries can change in the background during Setup's live worldbook extraction, with no local action to hook a one-off refresh onto. */
const POLL_MS = 3000;

interface Draft {
  pageId: string | null; // null = creating a new entry
  entryType: WorldbookEntryType;
  content: string;
}

/** entryType + a truncated first-line preview, since entries have no separate name field — just a raw content blob. */
function previewText(content: string, max = 60): string {
  const firstLine = content.split("\n")[0] ?? "";
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

export default function WorldbookView({ story }: PanelProps) {
  const storyId = story?.id;
  const [entries, setEntries] = useState<WorldbookEntry[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload(opts?: { background?: boolean }) {
    if (!storyId) return;
    setEntries(await fetchWorldbook(storyId, opts));
  }

  useEffect(() => {
    void reload();
    const interval = setInterval(() => void reload({ background: true }), POLL_MS);
    return () => clearInterval(interval);
  }, [storyId]);

  function startCreate() {
    setError(null);
    setDraft({ pageId: null, entryType: "roster", content: "" });
  }

  function startEdit(entry: WorldbookEntry) {
    setError(null);
    setDraft({ pageId: entry.pageId, entryType: entry.entryType, content: entry.content });
  }

  async function saveDraft() {
    if (!draft || !storyId) return;
    if (!draft.content.trim()) {
      setError("Content is required.");
      return;
    }
    try {
      if (draft.pageId) {
        await updateWorldbookEntry(storyId, draft.pageId, { content: draft.content });
      } else {
        await createWorldbookEntry(storyId, { entryType: draft.entryType, content: draft.content });
      }
      setDraft(null);
      await reload();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleHidden(entry: WorldbookEntry) {
    if (!storyId) return;
    await updateWorldbookEntry(storyId, entry.pageId, { hidden: !entry.hidden });
    await reload();
  }

  if (!storyId) return <div className="worldbook-view">No active story.</div>;

  const grouped = ENTRY_TYPES.map((type) => ({ type, items: entries.filter((e) => e.entryType === type) }));

  return (
    <div className="worldbook-view">
      <div className="worldbook-header">
        <h2>Worldbook</h2>
        <button type="button" onClick={startCreate} disabled={!!draft}>
          + New entry
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {draft ? (
        <EntryForm draft={draft} onChange={setDraft} onSave={saveDraft} onCancel={() => setDraft(null)} />
      ) : (
        grouped.map(
          ({ type, items }) =>
            items.length > 0 && (
              <div key={type} className="entry-group">
                <h3>{type}</h3>
                {items.map((entry) => (
                  <div key={entry.pageId} className={`entry-card ${entry.hidden ? "entry-hidden" : ""}`}>
                    <div className="entry-card-top">
                      <div className="entry-card-header">
                        <strong>{previewText(entry.content)}</strong>
                      </div>
                      <div className="entry-card-actions">
                        <button type="button" onClick={() => startEdit(entry)}>
                          Edit
                        </button>
                        <button type="button" onClick={() => toggleHidden(entry)}>
                          {entry.hidden ? "unhide" : "hide"}
                        </button>
                      </div>
                    </div>
                    <div className="entry-card-content">
                      <EntryContent content={entry.content} />
                    </div>
                  </div>
                ))}
              </div>
            )
        )
      )}
    </div>
  );
}

function EntryForm({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const isNew = draft.pageId === null;

  return (
    <div className="entry-form">
      <div className="entry-form-row">
        {isNew ? (
          <select value={draft.entryType} onChange={(e) => onChange({ ...draft, entryType: e.target.value as WorldbookEntryType })}>
            {ENTRY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        ) : (
          <span className="entry-form-type">{draft.entryType}</span>
        )}
      </div>

      <label className="entry-form-field">
        Content
        <textarea value={draft.content} onChange={(e) => onChange({ ...draft, content: e.target.value })} />
      </label>

      <div className="entry-form-actions">
        <button type="button" onClick={onSave}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
