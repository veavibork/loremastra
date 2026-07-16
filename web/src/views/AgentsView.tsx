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
import NumberField from '../components/fields/NumberField.js'
import CheckboxField from '../components/fields/CheckboxField.js'
import SelectField from '../components/fields/SelectField.js'
import '../components/fields/fields.css'
import './AgentsView.css'

export default function AgentsView() {
  const { data: configs, isLoading } = useModelConfigs()
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [featherlessCatalog, setFeatherlessCatalog] = useState<CatalogModel[] | null>(null)
  const [hordeCatalog, setHordeCatalog] = useState<CatalogModel[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, ModelConfigPatch>>({})
  const [saving, setSaving] = useState(false)
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null)
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
    const target = index + direction
    if (target < 0 || target >= orderedConfigs.length) return
    const next = orderedConfigs.slice()
    ;[next[index], next[target]] = [next[target], next[index]]
    setPendingOrder(next.map((c) => c.id))
  }

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
        Each card is a model call profile. Check which agent role(s) it's eligible for; within a
        role, active cards are tried top to bottom — the first is primary, the rest are ranked
        fallbacks. Card order is shared across all three roles, so reordering affects every role's
        fallback chain at once. Field edits are drafts until you click "Save changes" below.
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

      <div className="agents-cards">
        {orderedConfigs.map((cfg, index) => {
          const provider = getVal(cfg, 'provider')
          const deleted = pendingDeletes.has(cfg.id)
          return (
            <div
              key={cfg.id}
              className={[
                'agent-card',
                getVal(cfg, 'active') ? '' : 'card-inactive',
                isDirty(cfg.id) ? 'card-dirty' : '',
                deleted ? 'card-pending-delete' : '',
              ]
                .join(' ')
                .trim()}
            >
              <div className="agent-card-header">
                <div className="agent-card-reorder">
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
                </div>
                <span className="agent-card-title">{getVal(cfg, 'model') || 'Untitled model'}</span>
                <div className="agent-card-actions">
                  {deleted ? (
                    <>
                      <span className="agent-card-deleted">Marked for deletion</span>
                      <button type="button" onClick={() => unstageDelete(cfg.id)}>
                        Undo
                      </button>
                    </>
                  ) : confirmingDeleteId === cfg.id ? (
                    <>
                      <span>Delete?</span>
                      <button type="button" className="danger" onClick={() => stageDelete(cfg.id)}>
                        Yes
                      </button>
                      <button type="button" onClick={() => setConfirmingDeleteId(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setConfirmingDeleteId(cfg.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              <div className="agent-card-body">
                <SelectField
                  label="Provider"
                  value={provider}
                  options={[
                    { value: 'featherless', label: 'Featherless' },
                    { value: 'horde', label: 'Horde' },
                  ]}
                  onChange={(v) => setDraft(cfg.id, { provider: v })}
                />

                <div className="agent-card-model-field">
                  <label className="field">
                    <span className="field-label">Model</span>
                    <input
                      type="text"
                      className="field-input field-input-text"
                      list={
                        provider === 'horde' ? 'horde-model-catalog' : 'featherless-model-catalog'
                      }
                      value={getVal(cfg, 'model')}
                      placeholder="provider/Model-Name"
                      onChange={(e) => applyModel(cfg.id, provider, e.target.value)}
                    />
                  </label>
                </div>

                <div className="form-row">
                  <NumberField
                    label="Temperature"
                    value={getVal(cfg, 'temperature')}
                    onChange={(v) => setDraft(cfg.id, { temperature: v ?? 0 })}
                    step={0.1}
                  />
                  <NumberField
                    label="Response limit"
                    value={getVal(cfg, 'responseLimit')}
                    onChange={(v) => setDraft(cfg.id, { responseLimit: v ?? 0 })}
                  />
                  <NumberField
                    label="Context limit"
                    value={getVal(cfg, 'contextLimit')}
                    onChange={(v) => setDraft(cfg.id, { contextLimit: v ?? 0 })}
                  />
                </div>

                <div className="form-row">
                  <NumberField
                    label="Presence penalty"
                    value={getVal(cfg, 'presencePenalty')}
                    onChange={(v) => setDraft(cfg.id, { presencePenalty: v ?? null })}
                    step={0.1}
                  />
                  <NumberField
                    label="Frequency penalty"
                    value={getVal(cfg, 'frequencyPenalty')}
                    onChange={(v) => setDraft(cfg.id, { frequencyPenalty: v ?? null })}
                    step={0.1}
                  />
                  <NumberField
                    label="Repetition penalty"
                    value={getVal(cfg, 'repetitionPenalty')}
                    onChange={(v) => setDraft(cfg.id, { repetitionPenalty: v ?? null })}
                    step={0.1}
                  />
                </div>

                <div className="form-row">
                  <NumberField
                    label="Top P"
                    value={getVal(cfg, 'topP')}
                    onChange={(v) => setDraft(cfg.id, { topP: v ?? null })}
                    step={0.05}
                  />
                  <NumberField
                    label="Top K"
                    value={getVal(cfg, 'topK')}
                    onChange={(v) => setDraft(cfg.id, { topK: v ?? null })}
                  />
                  <NumberField
                    label="Min P"
                    value={getVal(cfg, 'minP')}
                    onChange={(v) => setDraft(cfg.id, { minP: v ?? null })}
                    step={0.01}
                  />
                  <NumberField
                    label="Concurrency cost"
                    value={getVal(cfg, 'concurrencyCost')}
                    onChange={(v) => setDraft(cfg.id, { concurrencyCost: v ?? null })}
                    step={1}
                    placeholder="auto"
                  />
                </div>

                <fieldset className="form-palette">
                  <legend>Roles</legend>
                  <CheckboxField
                    label="Author"
                    checked={getVal(cfg, 'useAuthor')}
                    onChange={(v) => setDraft(cfg.id, { useAuthor: v })}
                  />
                  <CheckboxField
                    label="Editor"
                    checked={getVal(cfg, 'useEditor')}
                    onChange={(v) => setDraft(cfg.id, { useEditor: v })}
                  />
                  <CheckboxField
                    label="Worker"
                    checked={getVal(cfg, 'useWorker')}
                    onChange={(v) => setDraft(cfg.id, { useWorker: v })}
                  />
                  <CheckboxField
                    label="Active"
                    checked={getVal(cfg, 'active')}
                    onChange={(v) => setDraft(cfg.id, { active: v })}
                  />
                </fieldset>

                <div className="agent-card-stats">
                  {cfg.successCount}✓ / {cfg.failCount}✗ · {cfg.inputTokens}in / {cfg.outputTokens}
                  out
                </div>
              </div>
            </div>
          )
        })}
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
