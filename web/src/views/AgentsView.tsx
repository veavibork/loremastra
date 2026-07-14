import { useState } from 'react'
import {
  createModelConfig,
  deleteModelConfig,
  fetchModelCatalog,
  reorderModelConfigs,
  updateModelConfig,
  type CatalogModel,
  type ModelConfig,
  type ModelConfigPatch,
} from '../api'
import { useModelConfigs } from '../hooks/use-agents'
import { useQueryClient } from '@tanstack/react-query'
import ApiKeysSection from './ApiKeysSection'
import './AgentsView.css'

function numOrUndefined(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const n = Number(value)
  return Number.isNaN(n) ? undefined : n
}

export default function AgentsView() {
  const { data: configs, isLoading } = useModelConfigs()
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [featherlessCatalog, setFeatherlessCatalog] = useState<CatalogModel[] | null>(null)
  const [hordeCatalog, setHordeCatalog] = useState<CatalogModel[] | null>(null)
  // Unsaved edits, keyed by row id — nothing here reaches the server until "Save changes" is
  // clicked, mirroring the Settings tab's draft/save/cancel pattern instead of committing every
  // field on blur/change.
  const [drafts, setDrafts] = useState<Record<string, ModelConfigPatch>>({})
  const [saving, setSaving] = useState(false)
  // Row order, like every other field, is a draft until "Save changes" — reordering used to call
  // reorderModelConfigs immediately, committing instantly while every other edit on the same row
  // still sat unsaved. Null means "no pending reorder."
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null)
  // Delete used to fire immediately on click, with no confirmation and no way to back out —
  // the only field on this whole screen that didn't wait for "Save changes." Now it's a
  // two-step inline confirm (mirroring SavesView's delete UX) that just stages the row for
  // removal; the actual deleteModelConfig call happens in handleSaveAll like everything else,
  // and "Cancel" un-stages it same as any other draft.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set())

  function getVal<K extends keyof ModelConfig>(cfg: ModelConfig, key: K): ModelConfig[K] {
    const draft = drafts[cfg.id]
    if (draft && key in draft) return draft[key as keyof ModelConfigPatch] as ModelConfig[K]
    return cfg[key]
  }

  function setDraft(id: string, fields: ModelConfigPatch) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...fields } }))
  }

  function isDirty(id: string): boolean {
    return !!drafts[id] && Object.keys(drafts[id]).length > 0
  }

  const dirty =
    Object.keys(drafts).some(isDirty) || pendingOrder !== null || pendingDeletes.size > 0

  async function handleSaveAll() {
    setError(null)
    setSaving(true)
    const failures: string[] = []

    for (const id of pendingDeletes) {
      try {
        await deleteModelConfig(id)
        setDrafts((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
      } catch (err) {
        console.error(err)
        failures.push(id)
      }
    }
    setPendingDeletes(new Set())

    const ids = Object.keys(drafts).filter((id) => isDirty(id) && !pendingDeletes.has(id))
    for (const id of ids) {
      const pending: ModelConfigPatch = { ...drafts[id] }
      if (typeof pending.model === 'string') pending.model = pending.model.trim()
      try {
        await updateModelConfig(id, pending)
        setDrafts((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      } catch (err) {
        console.error(err)
        failures.push(id)
      }
    }
    if (pendingOrder) {
      try {
        await reorderModelConfigs(pendingOrder.filter((id) => !pendingDeletes.has(id)))
        setPendingOrder(null)
      } catch (err) {
        console.error(err)
        failures.push('order')
      }
    }
    qc.invalidateQueries({ queryKey: ['model-configs'] })
    setSaving(false)
    if (failures.length)
      setError(`Failed to save ${failures.length} change(s) — see console for details.`)
  }

  async function handleCancelAll() {
    setDrafts({})
    setError(null)
    setConfirmingDeleteId(null)
    const hadPendingDeletes = pendingDeletes.size > 0
    setPendingDeletes(new Set())
    if (pendingOrder || hadPendingDeletes) {
      setPendingOrder(null)
      qc.invalidateQueries({ queryKey: ['model-configs'] })
    }
  }

  async function handleAdd() {
    try {
      await createModelConfig()
      qc.invalidateQueries({ queryKey: ['model-configs'] })
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function stageDelete(id: string) {
    setConfirmingDeleteId(null)
    setPendingDeletes((prev) => new Set(prev).add(id))
  }

  function unstageDelete(id: string) {
    setPendingDeletes((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  // Looks up the just-selected model in whichever catalog is loaded for the row's provider, and
  // if Featherless reported a real concurrency cost for it, carries that into the same draft —
  // the point of this whole column is that cost is a property of the model, not something to
  // leave at whatever the row happened to default to.
  function applyModel(id: string, provider: ModelConfig['provider'], model: string) {
    const catalog = provider === 'horde' ? hordeCatalog : featherlessCatalog
    const match = catalog?.find((m) => m.id === model)
    setDraft(id, {
      model,
      ...(match?.concurrencyCost != null ? { concurrencyCost: match.concurrencyCost } : {}),
    })
  }

  async function handleFetchFeatherlessModels() {
    try {
      setFeatherlessCatalog(await fetchModelCatalog('featherless'))
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleFetchHordeModels() {
    try {
      setHordeCatalog(await fetchModelCatalog('horde'))
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function move(index: number, direction: -1 | 1) {
    if (!configs) return
    const target = index + direction
    if (target < 0 || target >= configs.length) return
    const next = [...configs]
    ;[next[index], next[target]] = [next[target], next[index]]
    setPendingOrder(next.map((c) => c.id))
  }

  // Use pending order if set, otherwise the server order.
  const orderedConfigs = pendingOrder
    ? (configs ?? [])
        .slice()
        .sort((a, b) => pendingOrder.indexOf(a.id) - pendingOrder.indexOf(b.id))
    : (configs ?? [])

  if (isLoading || !configs) return <div className="agents-view">Loading…</div>

  return (
    <div className="agents-view">
      <h2>Agents</h2>
      <p className="agents-note">
        Each row is a model call profile. Check which agent role(s) it's eligible for; within a
        role, active rows are tried top to bottom — the first is primary, the rest are ranked
        fallbacks. Row order is shared across all three roles, so reordering affects every role's
        fallback chain at once. Field edits are drafts until you click "Save changes" below the
        table.
      </p>
      {error && <div className="error-banner">{error}</div>}

      <ApiKeysSection />

      <div className="catalog-controls">
        <button type="button" onClick={handleFetchFeatherlessModels}>
          Fetch Featherless models
        </button>
        {featherlessCatalog && (
          <span className="catalog-status">{featherlessCatalog.length} models loaded.</span>
        )}
        <button type="button" onClick={handleFetchHordeModels}>
          Fetch Horde models
        </button>
        {hordeCatalog && (
          <span className="catalog-status">{hordeCatalog.length} models loaded.</span>
        )}
      </div>
      <datalist id="featherless-model-catalog">
        {(featherlessCatalog ?? []).map((m) => (
          <option key={m.id} value={m.id} />
        ))}
      </datalist>
      <datalist id="horde-model-catalog">
        {(hordeCatalog ?? []).map((m) => (
          <option key={m.id} value={m.id} />
        ))}
      </datalist>

      <div className="agents-table-wrap">
        <table className="agents-table">
          <thead>
            <tr>
              <th></th>
              <th>Provider</th>
              <th>Model</th>
              <th>Temp</th>
              <th>Resp</th>
              <th>Ctx</th>
              <th>PresP</th>
              <th>FreqP</th>
              <th>RepP</th>
              <th>TopP</th>
              <th>TopK</th>
              <th>MinP</th>
              <th title="Concurrency units this model consumes against the account's slot limit — auto-filled from Fetch models, editable, blank falls back to a per-role default.">
                Cost
              </th>
              <th>A</th>
              <th>E</th>
              <th>W</th>
              <th>Active</th>
              <th>Stats</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orderedConfigs.map((cfg, index) => (
              <tr
                key={cfg.id}
                className={[
                  getVal(cfg, 'active') ? '' : 'row-inactive',
                  isDirty(cfg.id) ? 'row-dirty' : '',
                  pendingDeletes.has(cfg.id) ? 'row-pending-delete' : '',
                ]
                  .join(' ')
                  .trim()}
              >
                <td className="reorder-cell">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    title="Move up"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === orderedConfigs.length - 1}
                    title="Move down"
                  >
                    ▼
                  </button>
                </td>
                <td>
                  <select
                    value={getVal(cfg, 'provider')}
                    onChange={(e) =>
                      setDraft(cfg.id, { provider: e.target.value as ModelConfig['provider'] })
                    }
                  >
                    <option value="featherless">Featherless</option>
                    <option value="horde">Horde</option>
                  </select>
                </td>
                <td>
                  <input
                    className="model-input"
                    list={
                      getVal(cfg, 'provider') === 'horde'
                        ? 'horde-model-catalog'
                        : 'featherless-model-catalog'
                    }
                    value={getVal(cfg, 'model')}
                    placeholder="provider/Model-Name"
                    onChange={(e) => applyModel(cfg.id, getVal(cfg, 'provider'), e.target.value)}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.1"
                    className="num-input"
                    value={getVal(cfg, 'temperature')}
                    onChange={(e) => setDraft(cfg.id, { temperature: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    className="num-input"
                    value={getVal(cfg, 'responseLimit')}
                    onChange={(e) => setDraft(cfg.id, { responseLimit: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    className="num-input"
                    value={getVal(cfg, 'contextLimit')}
                    onChange={(e) => setDraft(cfg.id, { contextLimit: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.1"
                    className="num-input narrow"
                    value={getVal(cfg, 'presencePenalty') ?? ''}
                    onChange={(e) =>
                      setDraft(cfg.id, { presencePenalty: numOrUndefined(e.target.value) ?? null })
                    }
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.1"
                    className="num-input narrow"
                    value={getVal(cfg, 'frequencyPenalty') ?? ''}
                    onChange={(e) =>
                      setDraft(cfg.id, { frequencyPenalty: numOrUndefined(e.target.value) ?? null })
                    }
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.1"
                    className="num-input narrow"
                    value={getVal(cfg, 'repetitionPenalty') ?? ''}
                    onChange={(e) =>
                      setDraft(cfg.id, {
                        repetitionPenalty: numOrUndefined(e.target.value) ?? null,
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.05"
                    className="num-input narrow"
                    value={getVal(cfg, 'topP') ?? ''}
                    onChange={(e) =>
                      setDraft(cfg.id, { topP: numOrUndefined(e.target.value) ?? null })
                    }
                  />
                </td>
                <td>
                  <input
                    type="number"
                    className="num-input narrow"
                    value={getVal(cfg, 'topK') ?? ''}
                    onChange={(e) =>
                      setDraft(cfg.id, { topK: numOrUndefined(e.target.value) ?? null })
                    }
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.01"
                    className="num-input narrow"
                    value={getVal(cfg, 'minP') ?? ''}
                    onChange={(e) =>
                      setDraft(cfg.id, { minP: numOrUndefined(e.target.value) ?? null })
                    }
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="1"
                    className="num-input narrow"
                    value={getVal(cfg, 'concurrencyCost') ?? ''}
                    placeholder="auto"
                    onChange={(e) =>
                      setDraft(cfg.id, { concurrencyCost: numOrUndefined(e.target.value) ?? null })
                    }
                  />
                </td>
                <td className="checkbox-cell">
                  <input
                    type="checkbox"
                    checked={getVal(cfg, 'useAuthor')}
                    onChange={(e) => setDraft(cfg.id, { useAuthor: e.target.checked })}
                  />
                </td>
                <td className="checkbox-cell">
                  <input
                    type="checkbox"
                    checked={getVal(cfg, 'useEditor')}
                    onChange={(e) => setDraft(cfg.id, { useEditor: e.target.checked })}
                  />
                </td>
                <td className="checkbox-cell">
                  <input
                    type="checkbox"
                    checked={getVal(cfg, 'useWorker')}
                    onChange={(e) => setDraft(cfg.id, { useWorker: e.target.checked })}
                  />
                </td>
                <td className="checkbox-cell">
                  <input
                    type="checkbox"
                    checked={getVal(cfg, 'active')}
                    onChange={(e) => setDraft(cfg.id, { active: e.target.checked })}
                  />
                </td>
                <td className="stats-cell">
                  {cfg.successCount}✓ / {cfg.failCount}✗
                  <br />
                  {cfg.inputTokens}in / {cfg.outputTokens}out
                </td>
                <td>
                  {pendingDeletes.has(cfg.id) ? (
                    <div className="delete-confirm-inline">
                      <span>Marked for deletion.</span>
                      <button type="button" onClick={() => unstageDelete(cfg.id)}>
                        Undo
                      </button>
                    </div>
                  ) : confirmingDeleteId === cfg.id ? (
                    <div className="delete-confirm-inline">
                      <span>Delete this row?</span>
                      <button type="button" className="danger" onClick={() => stageDelete(cfg.id)}>
                        Yes
                      </button>
                      <button type="button" onClick={() => setConfirmingDeleteId(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setConfirmingDeleteId(cfg.id)}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dirty && (
        <div className="agents-savebar">
          <button type="button" onClick={handleSaveAll} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" onClick={handleCancelAll} disabled={saving}>
            Cancel
          </button>
        </div>
      )}

      <button type="button" onClick={handleAdd}>
        + New model
      </button>
    </div>
  )
}
