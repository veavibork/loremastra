import { useCallback, useEffect, useState } from 'react'
import { fetchPromptPreview, type PromptMessage, type PromptPreview } from './api'
import { classifyPromptBlock, promptBlockLabel } from './prompt-block'
import type { PanelProps } from './panel-types'
import './PromptMessage.css'
import './MemoryView.css'

function messageClass(m: PromptMessage): string {
  const kind = classifyPromptBlock(m.content, m.role)
  if (
    kind === 'content' ||
    kind === 'roster' ||
    kind === 'memory' ||
    kind === 'story-to-date' ||
    kind === 'event-summary'
  ) {
    return `prompt-message prompt-block-${kind}`
  }
  return `prompt-message prompt-message-${m.role}`
}

function formatHeaderMeta(m: PromptMessage, label: string): string {
  const parts = [label, `${m.tokenEstimate.toLocaleString()} tok`]
  if (m.icPostNumber != null) parts.push(`post ${m.icPostNumber}`)
  parts.push(`Σ ${m.cumulativeTokens.toLocaleString()}`)
  return parts.join(' · ')
}

export default function MemoryView({ story }: PanelProps) {
  const storyId = story?.id
  const [preview, setPreview] = useState<PromptPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!storyId) return
    setLoading(true)
    setError(null)
    try {
      setPreview(await fetchPromptPreview(storyId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [storyId])

  useEffect(() => {
    void reload()
  }, [reload])

  if (!story) return <div className="memory-view">No active story.</div>

  const messages = preview?.messages ?? []

  return (
    <div className="memory-view">
      <div className="memory-header">
        <h2>Memory</h2>
        <button type="button" onClick={() => void reload()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <p className="memory-note">
        Read-only Author prompt at the current position — worldbook, [STORY TO DATE], then verbose
        IC prose. Token counts use the same ~4 chars/token estimate as the story-to-date trigger.
        Click Refresh after posts or memory changes — not polled automatically.
      </p>
      {error && <p className="memory-error">{error}</p>}
      {preview && (
        <p className="memory-budget-bar">
          <span>
            Total <strong>{preview.totalTokens.toLocaleString()}</strong> tok
          </span>
          <span>
            Usable budget <strong>{preview.usableBudget.toLocaleString()}</strong> tok
          </span>
          <span>
            Archive trigger <strong>{preview.storyToDateTriggerAt.toLocaleString()}</strong> tok
            (80%)
          </span>
          {preview.totalTokens >= preview.storyToDateTriggerAt && (
            <span className="memory-budget-over">≥ archive threshold</span>
          )}
        </p>
      )}

      {messages.map((m, i) => {
        const kind = classifyPromptBlock(m.content, m.role)
        const label =
          kind === 'user' || kind === 'assistant' || kind === 'system'
            ? m.role
            : promptBlockLabel(kind)
        return (
          <div key={i} className={messageClass(m)}>
            <span className="prompt-message-role">{formatHeaderMeta(m, label)}</span>
            <p>{m.content}</p>
          </div>
        )
      })}
    </div>
  )
}
