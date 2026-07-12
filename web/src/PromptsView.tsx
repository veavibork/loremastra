import { useEffect, useState } from 'react'
import { fetchPrompts, type PromptCatalogEntry } from './api'
import './PromptsView.css'

/**
 * Per-user override editing still isn't built (that's a bigger, separate feature — see
 * docs/stub-revisions.md) but the underlying gap this used to describe — "there's no core
 * prompt to look at" — is gone now that the Author/Editor/Worker all run on real prompt
 * constants. This shows the actual current template library: what exists, who uses it, and
 * where it lives in source, as distinct from Memory which shows one story's *assembled* prompt
 * (worldbook entries and history mixed in) rather than the source templates themselves.
 */
export default function PromptsView() {
  const [prompts, setPrompts] = useState<PromptCatalogEntry[] | null>(null)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    void fetchPrompts().then(setPrompts)
  }, [])

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (!prompts) return <div className="prompts-view">Loading…</div>

  const needle = filter.trim().toLowerCase()
  const filtered = needle
    ? prompts.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          p.usedBy.toLowerCase().includes(needle) ||
          p.sourceFile.toLowerCase().includes(needle) ||
          p.content.toLowerCase().includes(needle),
      )
    : prompts

  return (
    <div className="prompts-view">
      <h2>Prompts</h2>
      <p className="prompts-note">
        The complete set of prompt and tool-schema blocks the app's agents run on today. Per-user
        override editing isn't built yet — this is the current source library, read-only.
      </p>

      <input
        className="prompts-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by name, agent, file, or content…"
      />

      <div className="prompt-list">
        {filtered.map((p) => {
          const isOpen = expanded.has(p.id)
          return (
            <div key={p.id} className="prompt-entry">
              <button type="button" className="prompt-entry-header" onClick={() => toggle(p.id)}>
                <span className="prompt-caret">{isOpen ? '▾' : '▸'}</span>
                <span className="prompt-name">{p.name}</span>
                <span className="prompt-kind">{p.kind}</span>
                <span className="prompt-used-by">{p.usedBy}</span>
              </button>
              <div className="prompt-source">{p.sourceFile}</div>
              {isOpen && <pre className="prompt-content">{p.content}</pre>}
            </div>
          )
        })}
        {filtered.length === 0 && <p className="prompts-empty">No prompts match "{filter}".</p>}
      </div>
    </div>
  )
}
