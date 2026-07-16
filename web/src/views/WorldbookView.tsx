import { useState } from 'react'
import { fetchJob, type WorldbookEntry, type WorldbookEntryType } from '../api'
import { useWorldbook } from '../hooks/use-worldbook'
import {
  useCreateWorldbookEntry,
  useUpdateWorldbookEntry,
  useCompactWorldbook,
} from '../hooks/use-worldbook-mutations'
import EntryContent from '../components/EntryContent'
import type { PanelProps } from '../lib/panel-types'
import './WorldbookView.css'

const ENTRY_TYPES: WorldbookEntryType[] = ['content', 'roster', 'memory']

const JOB_POLL_MS = 1500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Draft {
  pageId: string | null // null = creating a new entry
  entryType: WorldbookEntryType
  content: string
}

/** Skip prompt-leakage lines from a bad prior compact when picking a preview line. */
function previewText(content: string, max = 60): string {
  const line =
    content.split('\n').find((l) => {
      const t = l.trim()
      return (
        t &&
        !/^Entry type:\s*/i.test(t) &&
        !/^Worldbook entry to compact:/i.test(t) &&
        !/^\[(CONTENT|ROSTER|MEMORY)\]$/i.test(t)
      )
    }) ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

export default function WorldbookView({ story }: PanelProps) {
  const storyId = story?.id
  const { data: entries = [], refetch: refetchWorldbook } = useWorldbook(storyId ?? null)
  const createEntryMutation = useCreateWorldbookEntry()
  const updateEntryMutation = useUpdateWorldbookEntry()
  const compactMutation = useCompactWorldbook()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [compacting, setCompacting] = useState(false)
  const [compactSummary, setCompactSummary] = useState<string | null>(null)

  function toggleExpanded(pageId: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(pageId)) next.delete(pageId)
      else next.add(pageId)
      return next
    })
  }

  function startCreate() {
    setError(null)
    setDraft({ pageId: null, entryType: 'roster', content: '' })
  }

  function startEdit(entry: WorldbookEntry) {
    setError(null)
    setDraft({ pageId: entry.pageId, entryType: entry.entryType, content: entry.content })
  }

  async function saveDraft() {
    if (!draft || !storyId) return
    if (!draft.content.trim()) {
      setError('Content is required.')
      return
    }
    try {
      if (draft.pageId) {
        await updateEntryMutation.mutateAsync({
          storyId,
          pageId: draft.pageId,
          changes: { content: draft.content },
        })
      } else {
        await createEntryMutation.mutateAsync({
          storyId,
          entry: { entryType: draft.entryType, content: draft.content },
        })
      }
      setDraft(null)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function crunchWorldbook() {
    if (!storyId || compacting) return
    setError(null)
    setCompactSummary(null)
    setCompacting(true)
    try {
      const { jobId } = await compactMutation.mutateAsync(storyId)
      while (true) {
        await sleep(JOB_POLL_MS)
        const job = await fetchJob(storyId, jobId, { background: true })
        if (!job || job.status === 'pending' || job.status === 'running') continue
        if (job.status === 'done') {
          await refetchWorldbook()
          setCompactSummary(
            job.resultSummary ??
              (() => {
                const before = job.inputTokenEstimate ?? 0
                const after = job.tokenEstimate ?? 0
                const cut = before > 0 ? Math.round((1 - after / before) * 100) : 0
                return before > 0
                  ? `Crunch complete: ${before} → ${after} tokens (~${cut}% cut). See Queue tab for details.`
                  : 'Crunch complete. See Queue tab for details.'
              })(),
          )
          return
        }
        if (job.status === 'cancelled') {
          throw new Error('worldbook crunch was cancelled')
        }
        throw new Error(job.error ?? 'worldbook crunch failed')
      }
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCompacting(false)
    }
  }

  async function toggleHidden(entry: WorldbookEntry) {
    if (!storyId) return
    await updateEntryMutation.mutateAsync({
      storyId,
      pageId: entry.pageId,
      changes: { hidden: !entry.hidden },
    })
  }

  if (!storyId) return <div className="worldbook-view">No active story.</div>

  const grouped = ENTRY_TYPES.map((type) => ({
    type,
    items: entries.filter((e) => e.entryType === type),
  }))

  return (
    <div className="worldbook-view">
      <div className="worldbook-header">
        <h2>Worldbook</h2>
        <div className="worldbook-header-actions">
          <button
            type="button"
            onClick={() => void crunchWorldbook()}
            disabled={!!draft || compacting || entries.length === 0}
          >
            {compacting ? 'Crunching…' : 'Crunch worldbook'}
          </button>
          <button type="button" onClick={startCreate} disabled={!!draft || compacting}>
            + New entry
          </button>
        </div>
      </div>

      {compactSummary && <div className="worldbook-compact-summary">{compactSummary}</div>}

      {error && <div className="error-banner">{error}</div>}

      {draft ? (
        <EntryForm
          draft={draft}
          onChange={setDraft}
          onSave={saveDraft}
          onCancel={() => setDraft(null)}
        />
      ) : (
        grouped.map(
          ({ type, items }) =>
            items.length > 0 && (
              <div key={type} className="entry-group">
                <h3>{type}</h3>
                {items.map((entry) => {
                  const isExpanded = expanded.has(entry.pageId)
                  return (
                    <div
                      key={entry.pageId}
                      className={`entry-card ${entry.hidden ? 'entry-hidden' : ''}`}
                    >
                      <div className="entry-card-top">
                        <button
                          type="button"
                          className="entry-card-header"
                          onClick={() => toggleExpanded(entry.pageId)}
                        >
                          <span
                            className={`entry-card-caret ${isExpanded ? 'entry-card-caret-open' : ''}`}
                          >
                            ▸
                          </span>
                          <strong>{previewText(entry.content)}</strong>
                        </button>
                        <div className="entry-card-actions">
                          <button type="button" onClick={() => startEdit(entry)}>
                            Edit
                          </button>
                          <button type="button" onClick={() => toggleHidden(entry)}>
                            {entry.hidden ? 'unhide' : 'hide'}
                          </button>
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="entry-card-content">
                          <EntryContent content={entry.content} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ),
        )
      )}
    </div>
  )
}

function EntryForm({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft
  onChange: (d: Draft) => void
  onSave: () => void
  onCancel: () => void
}) {
  const isNew = draft.pageId === null

  return (
    <div className="entry-form">
      <div className="entry-form-row">
        {isNew ? (
          <select
            value={draft.entryType}
            onChange={(e) =>
              onChange({ ...draft, entryType: e.target.value as WorldbookEntryType })
            }
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
      </div>

      <label className="entry-form-field">
        Content
        <textarea
          value={draft.content}
          onChange={(e) => onChange({ ...draft, content: e.target.value })}
        />
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
  )
}
