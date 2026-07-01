import { useEffect, useState } from "react";
import {
  createTag,
  createWorldbookEntry,
  fetchTags,
  fetchWorldbook,
  fetchWorldbookSchemas,
  updateTag,
  updateWorldbookEntry,
  type Tag,
  type WorldbookEntry,
  type WorldbookEntryType,
  type WorldbookFieldSchema,
} from "./api";
import "./LoreView.css";

const ENTRY_TYPES: WorldbookEntryType[] = ["setting", "register", "location", "creature", "faction", "character"];

interface Draft {
  pageId: string | null; // null = creating a new entry
  entryType: WorldbookEntryType;
  isPc: boolean;
  name: string;
  fields: Record<string, string>;
}

export default function LoreView({ storyId }: { storyId: string }) {
  const [schemas, setSchemas] = useState<Record<WorldbookEntryType, WorldbookFieldSchema[]> | null>(null);
  const [entries, setEntries] = useState<WorldbookEntry[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newTagName, setNewTagName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setEntries(await fetchWorldbook(storyId));
    setTags(await fetchTags(storyId));
  }

  useEffect(() => {
    void fetchWorldbookSchemas().then(setSchemas);
    void reload();
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
    if (!draft) return;
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
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleHidden(entry: WorldbookEntry) {
    await updateWorldbookEntry(storyId, entry.pageId, { hidden: !entry.hidden });
    await reload();
  }

  async function submitNewTag(e: React.FormEvent) {
    e.preventDefault();
    if (!newTagName.trim()) return;
    try {
      await createTag(storyId, newTagName.trim());
      setNewTagName("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function renameTag(tag: Tag, name: string) {
    if (name === tag.name) return;
    try {
      await updateTag(storyId, tag.id, { name });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleTagHidden(tag: Tag) {
    await updateTag(storyId, tag.id, { hidden: !tag.hidden });
    await reload();
  }

  async function attachTag(tag: Tag, worldbookPageId: string | null) {
    await updateTag(storyId, tag.id, { worldbookPageId });
    await reload();
  }

  if (!schemas) return <div className="lore-view">Loading…</div>;

  const grouped = ENTRY_TYPES.map((type) => ({ type, items: entries.filter((e) => e.entryType === type) }));

  return (
    <div className="lore-view">
      <aside className="tag-cloud">
        <h2>Tags</h2>
        <form onSubmit={submitNewTag} className="tag-new-form">
          <input
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            placeholder="new-tag"
          />
          <button type="submit">Add</button>
        </form>
        <ul className="tag-list">
          {tags.map((tag) => (
            <li key={tag.id} className={tag.hidden ? "tag-hidden" : ""}>
              <input
                className="tag-name-input"
                defaultValue={tag.name}
                onBlur={(e) => renameTag(tag, e.target.value.trim())}
              />
              <select
                value={tag.worldbookPageId ?? ""}
                onChange={(e) => attachTag(tag, e.target.value || null)}
              >
                <option value="">(no entry)</option>
                {entries.map((entry) => (
                  <option key={entry.pageId} value={entry.pageId}>
                    {entry.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => toggleTagHidden(tag)}>
                {tag.hidden ? "unhide" : "hide"}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="worldbook-panel">
        <div className="worldbook-header">
          <h2>Worldbook</h2>
          <button type="button" onClick={startCreate}>
            + New entry
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {draft && (
          <EntryForm
            draft={draft}
            schemas={schemas}
            onChange={setDraft}
            onSave={saveDraft}
            onCancel={() => setDraft(null)}
          />
        )}

        {grouped.map(
          ({ type, items }) =>
            items.length > 0 && (
              <div key={type} className="entry-group">
                <h3>{type}</h3>
                {items.map((entry) => (
                  <div key={entry.pageId} className={`entry-card ${entry.hidden ? "entry-hidden" : ""}`}>
                    <div className="entry-card-header">
                      <strong>{entry.name}</strong>
                      {entry.isPc && <span className="pc-badge">PC</span>}
                      <span className="entry-tags">
                        {tagsForEntry(entry.pageId)
                          .map((t) => t.name)
                          .join(", ")}
                      </span>
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
        )}
      </section>
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
        <input
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder="Name"
        />
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
