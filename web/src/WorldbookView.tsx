import { useEffect, useState } from "react";
import {
  createWorldbookEntry,
  fetchTags,
  fetchWorldbook,
  fetchWorldbookSchemas,
  updateWorldbookEntry,
  type Tag,
  type WorldbookEntry,
  type WorldbookEntryType,
  type WorldbookFieldSchema,
} from "./api";
import type { PanelProps } from "./panel-types";
import "./WorldbookView.css";

const ENTRY_TYPES: WorldbookEntryType[] = ["setting", "register", "location", "creature", "faction", "character"];

/** Polls on a short interval — entries can change in the background during Setup's live worldbook extraction, with no local action to hook a one-off refresh onto. */
const POLL_MS = 3000;

interface Draft {
  pageId: string | null; // null = creating a new entry
  entryType: WorldbookEntryType;
  isPc: boolean;
  name: string;
  fields: Record<string, string>;
}

export default function WorldbookView({ story }: PanelProps) {
  const storyId = story?.id;
  const [schemas, setSchemas] = useState<Record<WorldbookEntryType, WorldbookFieldSchema[]> | null>(null);
  const [entries, setEntries] = useState<WorldbookEntry[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload(opts?: { background?: boolean }) {
    if (!storyId) return;
    setEntries(await fetchWorldbook(storyId, opts));
    setTags(await fetchTags(storyId, opts));
  }

  useEffect(() => {
    void fetchWorldbookSchemas().then(setSchemas);
    void reload();
    const interval = setInterval(() => void reload({ background: true }), POLL_MS);
    return () => clearInterval(interval);
  }, [storyId]);

  function tagsForEntry(pageId: string): Tag[] {
    return tags.filter((t) => t.worldbookPageId === pageId);
  }

  function startCreate() {
    setError(null);
    setDraft({ pageId: null, entryType: "character", isPc: false, name: "", fields: {} });
  }

  function startEdit(entry: WorldbookEntry) {
    setError(null);
    setDraft({ pageId: entry.pageId, entryType: entry.entryType, isPc: entry.isPc, name: entry.name, fields: { ...entry.fields } });
  }

  async function saveDraft() {
    if (!draft || !storyId) return;
    if (!draft.name.trim()) {
      setError("Name is required.");
      return;
    }
    try {
      if (draft.pageId) {
        await updateWorldbookEntry(storyId, draft.pageId, { name: draft.name, fields: draft.fields });
      } else {
        await createWorldbookEntry(storyId, {
          entryType: draft.entryType,
          isPc: draft.entryType === "character" ? draft.isPc : false,
          name: draft.name,
          fields: draft.fields,
        });
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
  if (!schemas) return <div className="worldbook-view">Loading…</div>;

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
        <EntryForm draft={draft} schemas={schemas} onChange={setDraft} onSave={saveDraft} onCancel={() => setDraft(null)} />
      ) : (
        grouped.map(
        ({ type, items }) =>
          items.length > 0 && (
            <div key={type} className="entry-group">
              <h3>{type}</h3>
              {items.map((entry) => (
                <div key={entry.pageId} className={`entry-card ${entry.hidden ? "entry-hidden" : ""}`}>
                  <div className="entry-card-header">
                    <strong>{entry.name}</strong>
                    {entry.isPc && <span className="pc-badge">PC</span>}
                    <span className="entry-tags">{tagsForEntry(entry.pageId).map((t) => t.name).join(", ")}</span>
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
  schemas,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft;
  schemas: Record<WorldbookEntryType, WorldbookFieldSchema[]>;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const schema = schemas[draft.entryType];
  const isNew = draft.pageId === null;

  return (
    <div className="entry-form">
      <div className="entry-form-row">
        {isNew ? (
          <select
            value={draft.entryType}
            onChange={(e) => onChange({ ...draft, entryType: e.target.value as WorldbookEntryType, fields: {} })}
          >
            {ENTRY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        ) : (
          <span className="entry-form-type">{draft.entryType}</span>
        )}
        <input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder="Name" />
        {isNew && draft.entryType === "character" && (
          <label className="pc-checkbox">
            <input
              type="checkbox"
              checked={draft.isPc}
              onChange={(e) => onChange({ ...draft, isPc: e.target.checked })}
            />
            PC
          </label>
        )}
      </div>

      {schema.map(({ key, label }) => (
        <label key={key} className="entry-form-field">
          {label}
          <textarea
            value={draft.fields[key] ?? ""}
            onChange={(e) => onChange({ ...draft, fields: { ...draft.fields, [key]: e.target.value } })}
          />
        </label>
      ))}

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
