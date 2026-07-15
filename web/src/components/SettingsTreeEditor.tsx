import { useEffect, useState } from 'react'
import './SettingsTreeEditor.css'
import GlobalCssForm from './GlobalCssForm.js'
import PlayTabForm from './PlayTabForm.js'
import BannedPhrasesForm from './BannedPhrasesForm.js'
import JsonTextarea from './JsonTextarea.js'

/** Every settings-space value is either an object or an array. */
export type JsonData = Record<string, unknown> | unknown[]

export interface SettingsSection {
  /** Stable identifier, independent of the display title. */
  key: string
  title: string
  description?: string
  value: JsonData
  onChange?: (value: JsonData) => void
  onSave: (value: JsonData) => Promise<JsonData>
  onRevert?: () => Promise<JsonData>
  parent?: string
  parentKey?: string
}

interface SectionState {
  lastSaved: JsonData
  draft: JsonData
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function initState(sections: SettingsSection[]): Record<string, SectionState> {
  return Object.fromEntries(sections.map((s) => [s.key, { lastSaved: s.value, draft: s.value }]))
}

/** Render the editor for a single section, dispatching by key. */
function renderSection(
  section: SettingsSection,
  draft: JsonData,
  onChange: (value: JsonData) => void,
) {
  switch (section.key) {
    case 'global-css':
      return <GlobalCssForm value={draft} onChange={onChange} />
    case 'play-tab':
      return <PlayTabForm value={draft} onChange={onChange} />
    case 'banned-phrases':
      return <BannedPhrasesForm value={draft} onChange={onChange} />
    default:
      return <JsonTextarea value={draft} onChange={onChange} label={section.title} />
  }
}

export default function SettingsTreeEditor({ sections }: { sections: SettingsSection[] }) {
  const [state, setState] = useState<Record<string, SectionState>>(() => initState(sections))
  const [error, setError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)

  // Resync a section's draft/lastSaved from its incoming `value` prop only while that specific
  // section isn't dirty — so an unsaved edit on one space is never clobbered by an unrelated
  // update on another.
  useEffect(() => {
    setState((prev) => {
      let changed = false
      const next = { ...prev }
      for (const s of sections) {
        const cur = prev[s.key]
        if (!cur) {
          next[s.key] = { lastSaved: s.value, draft: s.value }
          changed = true
          continue
        }
        const branchDirty = stringify(cur.draft) !== stringify(cur.lastSaved)
        if (!branchDirty && stringify(cur.lastSaved) !== stringify(s.value)) {
          next[s.key] = { lastSaved: s.value, draft: s.value }
          changed = true
        }
      }
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections])

  const dirtySections = sections.filter(
    (s) => stringify(state[s.key]?.draft) !== stringify(state[s.key]?.lastSaved),
  )
  const dirty = dirtySections.length > 0

  function handleSectionChange(section: SettingsSection, value: JsonData) {
    setError(null)
    setState((prev) => ({
      ...prev,
      [section.key]: { lastSaved: prev[section.key]?.lastSaved ?? section.value, draft: value },
    }))
    section.onChange?.(value)
  }

  async function handleSave() {
    setError(null)
    const toSave = sections.filter(
      (s) => stringify(state[s.key]?.draft) !== stringify(state[s.key]?.lastSaved),
    )
    try {
      for (const s of toSave) {
        const draftValue = state[s.key]?.draft ?? s.value
        const persisted = (await s.onSave(draftValue)) ?? draftValue
        setState((prev) => ({ ...prev, [s.key]: { lastSaved: persisted, draft: persisted } }))
      }
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function handleCancel() {
    setError(null)
    setState((prev) => {
      const next = { ...prev }
      for (const s of sections) {
        if (stringify(prev[s.key]?.draft) !== stringify(prev[s.key]?.lastSaved)) {
          next[s.key] = { lastSaved: prev[s.key].lastSaved, draft: prev[s.key].lastSaved }
          s.onChange?.(prev[s.key].lastSaved)
        }
      }
      return next
    })
  }

  async function handleRevertSection(section: SettingsSection) {
    if (!section.onRevert) return
    setError(null)
    try {
      const reverted = await section.onRevert()
      setState((prev) => ({ ...prev, [section.key]: { lastSaved: reverted, draft: reverted } }))
      section.onChange?.(reverted)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const revertable = sections.filter((s) => s.onRevert)

  return (
    <section className="settings-tree">
      {error && <div className="error-banner">{error}</div>}

      <div className="settings-tree-sections">
        {sections.map((s) => (
          <div key={s.key} className="settings-tree-section">
            <h3 className="settings-tree-section-title">
              {s.parent ? `${s.parent} → ${s.parentKey ?? s.title}` : s.title}
            </h3>
            {s.description && <p className="settings-tree-section-desc">{s.description}</p>}
            {renderSection(s, state[s.key]?.draft ?? s.value, (value) =>
              handleSectionChange(s, value),
            )}
          </div>
        ))}
      </div>

      {dirty && (
        <div className="settings-tree-savebar">
          <button type="button" onClick={handleSave}>
            {savedFlash ? 'Saved' : 'Save'}
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
            <strong>{s.parent ? `${s.parent} → ${s.parentKey ?? s.title}` : s.title}</strong>
            {s.description && <span> — {s.description}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}
