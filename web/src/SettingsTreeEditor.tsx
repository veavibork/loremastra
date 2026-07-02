import { useEffect, useState } from "react";
import { JsonEditor } from "json-edit-react";
import "./SettingsTreeEditor.css";

/** json-edit-react doesn't export its JsonData type; every settings-space value is either an object or an array. */
export type JsonData = Record<string, unknown> | unknown[];

export interface SettingsSection {
  /** Stable identifier, independent of the display title. */
  key: string;
  /** Display name — also doubles as the section's top-level key in the merged tree. */
  title: string;
  description?: string;
  value: JsonData;
  onSave: (value: JsonData) => Promise<JsonData | void>;
  onRevert?: () => Promise<JsonData>;
  onChange?: (value: JsonData) => void;
}

interface SectionState {
  lastSaved: JsonData;
  draft: JsonData;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function initState(sections: SettingsSection[]): Record<string, SectionState> {
  return Object.fromEntries(sections.map((s) => [s.key, { lastSaved: s.value, draft: s.value }]));
}

/**
 * All ThemeableElement colors point at the app's own CSS custom properties (see index.css /
 * globalCssSettings.ts) rather than hardcoded values, so the tree automatically follows
 * light/dark mode and any live Global CSS edits instead of always rendering in the library's
 * default light theme.
 */
const TREE_THEME = {
  displayName: "loremaster",
  styles: {
    container: { backgroundColor: "var(--bg)", color: "var(--text)", fontFamily: "var(--mono)" },
    property: "var(--text-h)",
    bracket: "var(--text)",
    itemCount: "var(--text)",
    string: "var(--accent)",
    number: "var(--accent)",
    boolean: "var(--accent)",
    null: "var(--border)",
    input: { backgroundColor: "var(--bg)", color: "var(--text-h)", border: "1px solid var(--accent-border)" },
    iconEdit: "var(--text)",
    iconDelete: "var(--text)",
    iconAdd: "var(--text)",
    iconCopy: "var(--text)",
    iconOk: "var(--accent)",
    iconCancel: "var(--text)",
  },
};

export default function SettingsTreeEditor({ sections }: { sections: SettingsSection[] }) {
  const [state, setState] = useState<Record<string, SectionState>>(() => initState(sections));
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [filter, setFilter] = useState("");
  const [collapseSignal, setCollapseSignal] = useState<{ path: string[]; collapsed: boolean; includeChildren: boolean } | undefined>();

  // Resync a section's draft/lastSaved from its incoming `value` prop only while that specific
  // section isn't dirty — so an unsaved edit on one space (e.g. Play tab) is never clobbered by
  // an unrelated update on another (e.g. Global CSS finishing its own fetch or save).
  useEffect(() => {
    setState((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const s of sections) {
        const cur = prev[s.key];
        if (!cur) {
          next[s.key] = { lastSaved: s.value, draft: s.value };
          changed = true;
          continue;
        }
        const branchDirty = stringify(cur.draft) !== stringify(cur.lastSaved);
        if (!branchDirty && stringify(cur.lastSaved) !== stringify(s.value)) {
          next[s.key] = { lastSaved: s.value, draft: s.value };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);

  const combinedDraft: Record<string, JsonData> = Object.fromEntries(
    sections.map((s) => [s.title, state[s.key]?.draft ?? s.value])
  );
  const combinedLastSaved: Record<string, JsonData> = Object.fromEntries(
    sections.map((s) => [s.title, state[s.key]?.lastSaved ?? s.value])
  );
  const dirtySections = sections.filter((s) => stringify(state[s.key]?.draft) !== stringify(state[s.key]?.lastSaved));
  const dirty = rawMode ? rawText !== stringify(combinedLastSaved) : dirtySections.length > 0;

  function enterRawMode() {
    setRawText(stringify(combinedDraft));
    setRawMode(true);
  }

  function exitRawMode() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setError("Top-level JSON must be an object keyed by section name.");
      return;
    }
    const obj = parsed as Record<string, unknown>;
    const missing = sections.filter((s) => !(s.title in obj));
    if (missing.length > 0) {
      setError(`Missing section(s): ${missing.map((s) => s.title).join(", ")}`);
      return;
    }
    setState((prev) => {
      const next = { ...prev };
      for (const s of sections) {
        next[s.key] = { lastSaved: prev[s.key]?.lastSaved ?? s.value, draft: obj[s.title] as JsonData };
      }
      return next;
    });
    for (const s of sections) {
      if (stringify(obj[s.title]) !== stringify(state[s.key]?.draft)) s.onChange?.(obj[s.title] as JsonData);
    }
    setError(null);
    setRawMode(false);
  }

  function handleTreeChange(newData: unknown) {
    const obj = newData as Record<string, JsonData>;
    setError(null);
    setState((prev) => {
      const next = { ...prev };
      for (const s of sections) {
        if (stringify(prev[s.key]?.draft) !== stringify(obj[s.title])) {
          next[s.key] = { lastSaved: prev[s.key]?.lastSaved ?? s.value, draft: obj[s.title] };
          s.onChange?.(obj[s.title]);
        }
      }
      return next;
    });
  }

  async function handleSave() {
    setError(null);
    let currentDraftByKey: Record<string, JsonData>;

    if (rawMode) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch (err) {
        setError(err instanceof Error ? `Not saved — invalid JSON: ${err.message}` : "Not saved — invalid JSON");
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setError("Not saved — top-level JSON must be an object keyed by section name.");
        return;
      }
      const obj = parsed as Record<string, unknown>;
      const missing = sections.filter((s) => !(s.title in obj));
      if (missing.length > 0) {
        setError(`Not saved — missing section(s): ${missing.map((s) => s.title).join(", ")}`);
        return;
      }
      currentDraftByKey = Object.fromEntries(sections.map((s) => [s.key, obj[s.title] as JsonData]));
    } else {
      currentDraftByKey = Object.fromEntries(sections.map((s) => [s.key, state[s.key]?.draft ?? s.value]));
    }

    const toSave = sections.filter((s) => stringify(currentDraftByKey[s.key]) !== stringify(state[s.key]?.lastSaved));
    try {
      for (const s of toSave) {
        const draftValue = currentDraftByKey[s.key];
        const persisted = (await s.onSave(draftValue)) ?? draftValue;
        setState((prev) => ({ ...prev, [s.key]: { lastSaved: persisted, draft: persisted } }));
      }
      if (rawMode) {
        setState((prev) => {
          const next = { ...prev };
          for (const s of sections) {
            if (!toSave.includes(s)) next[s.key] = { lastSaved: prev[s.key]?.lastSaved ?? s.value, draft: currentDraftByKey[s.key] };
          }
          return next;
        });
        setRawMode(false);
      }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleCancel() {
    setError(null);
    setState((prev) => {
      const next = { ...prev };
      for (const s of sections) {
        if (stringify(prev[s.key]?.draft) !== stringify(prev[s.key]?.lastSaved)) {
          next[s.key] = { lastSaved: prev[s.key].lastSaved, draft: prev[s.key].lastSaved };
          s.onChange?.(prev[s.key].lastSaved);
        }
      }
      return next;
    });
    setRawText(stringify(combinedLastSaved));
    setRawMode(false);
  }

  async function handleRevertSection(section: SettingsSection) {
    if (!section.onRevert) return;
    setError(null);
    try {
      const reverted = await section.onRevert();
      setState((prev) => ({ ...prev, [section.key]: { lastSaved: reverted, draft: reverted } }));
      section.onChange?.(reverted);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function setCollapseAll(collapsed: boolean) {
    setCollapseSignal({ path: [], collapsed, includeChildren: true });
  }

  const revertable = sections.filter((s) => s.onRevert);

  return (
    <section className="settings-tree">
      <div className="settings-tree-toolbar">
        <input
          type="search"
          className="settings-tree-filter"
          placeholder="Filter field names…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          disabled={rawMode}
        />
        <div className="settings-tree-toolbar-actions">
          <button type="button" onClick={() => setCollapseAll(false)} disabled={rawMode}>
            Expand all
          </button>
          <button type="button" onClick={() => setCollapseAll(true)} disabled={rawMode}>
            Collapse all
          </button>
          <button type="button" onClick={rawMode ? exitRawMode : enterRawMode}>
            {rawMode ? "Tree view" : "JSON edit"}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {rawMode ? (
        <textarea className="settings-tree-raw" value={rawText} onChange={(e) => setRawText(e.target.value)} spellCheck={false} />
      ) : (
        <div className="settings-tree-view">
          <JsonEditor
            data={combinedDraft}
            setData={handleTreeChange}
            rootName=""
            collapse={1}
            theme={TREE_THEME}
            rootFontSize="0.8rem"
            searchText={filter}
            searchFilter="all"
            showIconTooltips
            externalTriggers={{ collapse: collapseSignal }}
          />
        </div>
      )}

      {dirty && (
        <div className="settings-tree-savebar">
          <button type="button" onClick={handleSave}>
            {savedFlash ? "Saved" : "Save"}
          </button>
          <button type="button" onClick={handleCancel}>
            Cancel
          </button>
        </div>
      )}

      {revertable.length > 0 && (
        <div className="settings-tree-revertbar">
          <span>Revert to last saved:</span>
          {revertable.map((s) => (
            <button type="button" key={s.key} onClick={() => handleRevertSection(s)}>
              {s.title}
            </button>
          ))}
        </div>
      )}

      <ul className="settings-tree-legend">
        {sections.map((s) => (
          <li key={s.key}>
            <strong>{s.title}</strong>
            {s.description && <span> — {s.description}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
