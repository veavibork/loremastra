import { useEffect, useMemo, useState } from 'react'
import type {
  LayoutCatalog,
  LayoutCatalogEntry,
  LayoutConfigData,
  LayoutContainer,
  LayoutJustify,
} from '../api'
import './LayoutEditor.css'

/**
 * Checkbox/collapsible editor for the nav tab bar and story input bar layouts. Every button the
 * app knows (server-provided catalog) is always findable here — buttons removed from a container
 * appear under "Available" instead of vanishing, which the raw JSON editor can't offer.
 */

type RegionKey = 'nav' | 'inputBar'

const REGIONS: Array<{ key: RegionKey; title: string }> = [
  { key: 'inputBar', title: 'Input bar' },
  { key: 'nav', title: 'Nav tabs' },
]

interface LayoutEditorProps {
  layout: LayoutConfigData
  catalog: LayoutCatalog
  onSave: (config: LayoutConfigData) => Promise<LayoutConfigData>
}

function catalogLabel(entries: LayoutCatalogEntry[], id: string): string {
  return entries.find((e) => e.id === id)?.label ?? id
}

export default function LayoutEditor({ layout, catalog, onSave }: LayoutEditorProps) {
  const [draft, setDraft] = useState<LayoutConfigData>(layout)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Parent state is the saved truth; it only changes after a successful save (or initial load).
  useEffect(() => setDraft(layout), [layout])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(layout), [draft, layout])

  function patchContainer(region: RegionKey, containerId: string, patch: Partial<LayoutContainer>) {
    setDraft((d) => ({
      ...d,
      [region]: {
        containers: d[region].containers.map((c) =>
          c.id === containerId ? { ...c, ...patch } : c,
        ),
      },
    }))
  }

  function patchButton(
    region: RegionKey,
    containerId: string,
    buttonId: string,
    patch: { visible?: boolean; label?: string },
  ) {
    setDraft((d) => ({
      ...d,
      [region]: {
        containers: d[region].containers.map((c) =>
          c.id === containerId
            ? {
                ...c,
                buttons: c.buttons.map((b) => (b.id === buttonId ? { ...b, ...patch } : b)),
              }
            : c,
        ),
      },
    }))
  }

  function addButton(region: RegionKey, containerId: string, entry: LayoutCatalogEntry) {
    setDraft((d) => ({
      ...d,
      [region]: {
        containers: d[region].containers.map((c) =>
          c.id === containerId
            ? { ...c, buttons: [...c.buttons, { id: entry.id, label: entry.label, visible: true }] }
            : c,
        ),
      },
    }))
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      await onSave(draft)
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="layout-editor">
      <h3 className="settings-tree-section-title">Layout buttons</h3>
      <p className="settings-tree-section-desc">
        Which buttons appear in the story input bar and the nav tab bar. Unchecked buttons stay in
        the config but hidden; buttons not placed anywhere are listed under “Available” so they can
        always be added back. Reorder by dragging in the bar itself; raw JSON is under “Layout
        (advanced)” below.
      </p>
      {error && <div className="error-banner">{error}</div>}

      {REGIONS.map(({ key, title }) => {
        const containers = draft[key].containers
        const placedIds = new Set(containers.flatMap((c) => c.buttons.map((b) => b.id)))
        const available = catalog[key].filter((e) => !placedIds.has(e.id))
        return (
          <details key={key} className="layout-editor-region" open={key === 'inputBar'}>
            <summary>
              {title}
              <span className="layout-editor-count">
                {containers.reduce((n, c) => n + c.buttons.filter((b) => b.visible).length, 0)}{' '}
                shown
                {available.length > 0 ? ` · ${available.length} available` : ''}
              </span>
            </summary>

            {containers.map((c) => (
              <details key={c.id} className="layout-editor-container" open>
                <summary>
                  {c.label?.trim() || c.id}
                  <span className="layout-editor-count">
                    {c.buttons.filter((b) => b.visible).length} of {c.buttons.length} shown
                  </span>
                </summary>

                <div className="layout-editor-container-controls">
                  <label>
                    <input
                      type="checkbox"
                      checked={c.visible}
                      onChange={(e) => patchContainer(key, c.id, { visible: e.target.checked })}
                    />
                    Shown
                  </label>
                  <label>
                    Justify
                    <select
                      value={c.justify}
                      onChange={(e) =>
                        patchContainer(key, c.id, { justify: e.target.value as LayoutJustify })
                      }
                    >
                      <option value="left">left</option>
                      <option value="center">center</option>
                      <option value="right">right</option>
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={c.showButton}
                      onChange={(e) => patchContainer(key, c.id, { showButton: e.target.checked })}
                    />
                    Collapse button
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={c.showLabel}
                      onChange={(e) => patchContainer(key, c.id, { showLabel: e.target.checked })}
                    />
                    Group label
                  </label>
                </div>

                {c.buttons.map((b) => (
                  <div key={b.id} className="layout-editor-button-row">
                    <label className="layout-editor-button-shown">
                      <input
                        type="checkbox"
                        checked={b.visible}
                        onChange={(e) =>
                          patchButton(key, c.id, b.id, { visible: e.target.checked })
                        }
                      />
                    </label>
                    <input
                      type="text"
                      className="layout-editor-button-label"
                      value={b.label ?? ''}
                      placeholder={catalogLabel(catalog[key], b.id)}
                      onChange={(e) =>
                        patchButton(key, c.id, b.id, { label: e.target.value || undefined })
                      }
                    />
                    <code className="layout-editor-button-id">{b.id}</code>
                  </div>
                ))}
              </details>
            ))}

            {available.length > 0 && (
              <AvailableButtons
                region={key}
                entries={available}
                containers={containers}
                onAdd={addButton}
              />
            )}
          </details>
        )
      })}

      {dirty && (
        <div className="settings-tree-savebar">
          <button type="button" onClick={() => void handleSave()} disabled={saving}>
            {savedFlash ? 'Saved' : saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={() => setDraft(layout)} disabled={saving}>
            Revert
          </button>
        </div>
      )}
    </section>
  )
}

function AvailableButtons({
  region,
  entries,
  containers,
  onAdd,
}: {
  region: RegionKey
  entries: LayoutCatalogEntry[]
  containers: LayoutContainer[]
  onAdd: (region: RegionKey, containerId: string, entry: LayoutCatalogEntry) => void
}) {
  const [target, setTarget] = useState(containers[0]?.id ?? '')
  // Keep the target valid if the container list changes under us.
  useEffect(() => {
    if (!containers.some((c) => c.id === target)) setTarget(containers[0]?.id ?? '')
  }, [containers, target])

  if (!containers.length) return null
  return (
    <div className="layout-editor-available">
      <div className="layout-editor-available-header">
        Available — not placed in any group
        <label>
          Add to
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {containers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label?.trim() || c.id}
              </option>
            ))}
          </select>
        </label>
      </div>
      {entries.map((e) => (
        <div key={e.id} className="layout-editor-button-row">
          <button
            type="button"
            className="layout-editor-add"
            onClick={() => onAdd(region, target, e)}
          >
            + Add
          </button>
          <span className="layout-editor-button-label">{e.label}</span>
          <code className="layout-editor-button-id">{e.id}</code>
        </div>
      ))}
    </div>
  )
}
