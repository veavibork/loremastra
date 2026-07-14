import { useState } from 'react'
import { useStories, useCreateStory, useDeleteStory, useRenameStory } from '../hooks/use-stories'
import { fetchPhase, listStories, type Story } from '../api'
import type { PanelProps } from '../lib/panel-types'
import './SavesView.css'

function formatLastPlayed(iso: string | null): string {
  if (!iso) return 'never played'
  return new Date(iso).toLocaleString()
}

export default function SavesView({ story, onStoryChange, onPhaseChange }: PanelProps) {
  const { data: stories = [] } = useStories()
  const createMutation = useCreateStory()
  const deleteMutation = useDeleteStory()
  const renameMutation = useRenameStory()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [newName, setNewName] = useState('')
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleSwitch(target: Story) {
    onStoryChange(target)
    onPhaseChange((await fetchPhase(target.id)).phase)
  }

  async function handleRename(id: string) {
    if (!renameDraft.trim()) return
    try {
      await renameMutation.mutateAsync({ storyId: id, name: renameDraft.trim() })
      setRenamingId(null)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return
    try {
      const created = await createMutation.mutateAsync(newName.trim())
      setNewName('')
      await handleSwitch(created)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMutation.mutateAsync(id)
      setConfirmingDeleteId(null)
      if (story?.id === id) {
        const remaining = await listStories()
        const next = remaining[0] ?? (await createMutation.mutateAsync('Default Story'))
        await handleSwitch(next)
      }
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function parentName(parentId: string | null): string | null {
    if (!parentId) return null
    return stories.find((s) => s.id === parentId)?.name ?? '(unknown)'
  }

  return (
    <div className="saves-view">
      <h2>Saves</h2>
      {error && <div className="error-banner">{error}</div>}

      <form
        className="saves-new-form"
        onSubmit={(e) => {
          e.preventDefault()
          void handleCreate()
        }}
      >
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New story name"
        />
        <button type="submit">+ New story</button>
      </form>

      <ul className="saves-list">
        {stories.map((s) => (
          <li key={s.id} className={s.id === story?.id ? 'active' : ''}>
            {renamingId === s.id ? (
              <>
                <input value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} />
                <button type="button" onClick={() => handleRename(s.id)}>
                  Save
                </button>
                <button type="button" onClick={() => setRenamingId(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <div className="saves-row-top">
                <div className="saves-row-main">
                  <strong>{s.name}</strong>
                  {s.id === story?.id && <span className="current-badge">current</span>}
                  {parentName(s.parentStoryId) && (
                    <span className="fork-note">forked from {parentName(s.parentStoryId)}</span>
                  )}
                  {s.stats && (
                    <span className="saves-row-stats">
                      {s.stats.icPosts ?? '—'} IC posts &middot; {s.stats.chatRows} text versions
                      &middot; {s.stats.worldbookRows} worldbook entries &middot;{' '}
                      {formatLastPlayed(s.stats.lastPlayedAt)}
                    </span>
                  )}
                </div>
                {confirmingDeleteId === s.id ? (
                  <div className="saves-row-actions">
                    <span className="delete-confirm-label">Delete "{s.name}" permanently?</span>
                    <button type="button" className="danger" onClick={() => handleDelete(s.id)}>
                      Yes, delete
                    </button>
                    <button type="button" onClick={() => setConfirmingDeleteId(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="saves-row-actions">
                    <button
                      type="button"
                      onClick={() => handleSwitch(s)}
                      disabled={s.id === story?.id}
                    >
                      Switch
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingId(s.id)
                        setRenameDraft(s.name)
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setConfirmingDeleteId(s.id)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
