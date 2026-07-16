import { useEffect, useRef, type RefObject } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import EntryContent from './EntryContent'
import { RoleLabel } from './PlayTabSettings'
import { ReasoningTracePanel } from './ReasoningDisplay'
import AutoGrowTextarea from './AutoGrowTextarea'
import { cancelJob, type LogEntry } from '../api'
import { toast } from '../lib/toast'
import type { PendingReply } from '../views/StoryViewReducer'
import { pendingStatusLabel } from '../views/StoryViewHelpers'

interface StoryLogProps {
  onLogClick: (e: React.MouseEvent<HTMLDivElement>) => void
  hasMoreEntries: boolean
  loadingEarlier: boolean
  onLoadEarlier: () => void
  /** Receives Virtuoso's scroll container so StoryView can preserve scroll across tap-to-edit. */
  scrollerRef: RefObject<HTMLElement | null>
  shown: LogEntry[]
  editingPageId: string | null
  editDraft: string
  onEditDraftChange: (value: string) => void
  editInitialHeight: number | undefined
  editTextareaRef: RefObject<HTMLTextAreaElement | null>
  pendingCaretRef: RefObject<number | null>
  reasoningTraces: Record<string, string>
  reasoningExpanded: boolean
  showReasoning: boolean
  mode: 'guide' | 'play'
  pendingEntries: LogEntry[]
  pendingReplies: Record<string, PendingReply>
  storyId: string
  onHiddenPendingAdd: (pageId: string) => void
}

type VirtItem = { kind: 'entry'; entry: LogEntry } | { kind: 'pending'; entry: LogEntry }

export default function StoryLog({
  onLogClick,
  hasMoreEntries,
  loadingEarlier,
  onLoadEarlier,
  scrollerRef,
  shown,
  editingPageId,
  editDraft,
  onEditDraftChange,
  editInitialHeight,
  editTextareaRef,
  pendingCaretRef,
  reasoningTraces,
  reasoningExpanded,
  showReasoning,
  mode,
  pendingEntries,
  pendingReplies,
  storyId,
  onHiddenPendingAdd,
}: StoryLogProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // Tracks how many items have been prepended (loaded earlier) so Virtuoso can maintain
  // scroll position when older entries are inserted at the front of the data array.
  const firstItemIndexRef = useRef(0)
  const prevFirstPageIdRef = useRef<string | null>(null)

  // Detect prepends: if the first entry's pageId changed, older entries were inserted.
  const currentFirstPageId = shown[0]?.pageId ?? null
  if (
    prevFirstPageIdRef.current !== null &&
    currentFirstPageId !== null &&
    currentFirstPageId !== prevFirstPageIdRef.current
  ) {
    // Find how many new items were prepended by locating the old first item in the new array.
    const oldFirstIdx = shown.findIndex((e) => e.pageId === prevFirstPageIdRef.current)
    if (oldFirstIdx > 0) {
      firstItemIndexRef.current += oldFirstIdx
    }
  }
  prevFirstPageIdRef.current = currentFirstPageId

  const items: VirtItem[] = [
    ...shown.map((entry) => ({ kind: 'entry' as const, entry })),
    ...pendingEntries.map((entry) => ({ kind: 'pending' as const, entry })),
  ]

  return (
    <div className="log" onClick={onLogClick} style={{ height: '100%' }}>
      <Virtuoso
        ref={virtuosoRef}
        scrollerRef={(el) => {
          scrollerRef.current = el instanceof HTMLElement ? el : null
        }}
        data={items}
        firstItemIndex={firstItemIndexRef.current}
        followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
        atTopStateChange={(atTop) => {
          if (atTop && hasMoreEntries && !loadingEarlier) onLoadEarlier()
        }}
        components={{
          Header: () =>
            loadingEarlier ? (
              <div className="log-load-earlier">
                <span>Loading…</span>
              </div>
            ) : null,
        }}
        itemContent={(_index, item) => {
          if (item.kind === 'pending') {
            const entry = item.entry
            const pending = pendingReplies[entry.pageId]
            return (
              <div className="entry entry-agent entry-pending" key={entry.pageId}>
                <RoleLabel role="agent" mode={mode} />
                {!pending?.text?.trim() ? (
                  <p className="pending-thinking">
                    {pending ? pendingStatusLabel(pending) : 'Thinking…'}
                  </p>
                ) : null}
                {showReasoning && pending?.thinking?.trim() ? (
                  <ReasoningTracePanel
                    thinking={pending.thinking}
                    expanded={reasoningExpanded}
                    autoScroll={!pending.text?.trim()}
                  />
                ) : null}
                {pending?.text?.trim() ? (
                  <EntryContent content={pending.text} highlightBlocks={mode === 'guide'} />
                ) : null}
                {pending?.jobId && (
                  <button
                    type="button"
                    className="pending-stop-btn"
                    onClick={() =>
                      void cancelJob(storyId, pending.jobId).catch((err) => {
                        console.error(err)
                        onHiddenPendingAdd(entry.pageId)
                        toast.info(
                          "Still running in the background — it'll reappear when it finishes.",
                          "Can't stop this job",
                        )
                      })
                    }
                  >
                    ✕ stop
                  </button>
                )}
              </div>
            )
          }

          const entry = item.entry
          const cachedTrace =
            entry.role === 'agent' ? reasoningTraces[entry.pageId]?.trim() : undefined
          return (
            <div
              key={entry.pageId}
              data-page-id={entry.pageId}
              className={`entry entry-${entry.role}`}
            >
              <RoleLabel role={entry.role} mode={mode} />
              {entry.pageId === editingPageId ? (
                <EditEntry
                  editDraft={editDraft}
                  onEditDraftChange={onEditDraftChange}
                  editTextareaRef={editTextareaRef}
                  pendingCaretRef={pendingCaretRef}
                  editInitialHeight={editInitialHeight}
                  editingPageId={editingPageId}
                />
              ) : (
                <>
                  {cachedTrace ? (
                    <ReasoningTracePanel thinking={cachedTrace} expanded={reasoningExpanded} />
                  ) : null}
                  <EntryContent content={entry.content ?? '…'} highlightBlocks={mode === 'guide'} />
                </>
              )}
            </div>
          )
        }}
      />
    </div>
  )
}

/** Handles the edit-mode textarea focus when it mounts. */
function EditEntry({
  editDraft,
  onEditDraftChange,
  editTextareaRef,
  pendingCaretRef,
  editInitialHeight,
  editingPageId,
}: {
  editDraft: string
  onEditDraftChange: (value: string) => void
  editTextareaRef: RefObject<HTMLTextAreaElement | null>
  pendingCaretRef: RefObject<number | null>
  editInitialHeight: number | undefined
  editingPageId: string | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!editingPageId) return
    const textarea = containerRef.current?.querySelector<HTMLTextAreaElement>(
      'textarea.edit-box-textarea',
    )
    if (textarea && document.activeElement !== textarea) {
      textarea.focus({ preventScroll: true })
    }
  }, [editingPageId])

  return (
    <div ref={containerRef}>
      <AutoGrowTextarea
        className="edit-box-textarea"
        value={editDraft}
        onChange={onEditDraftChange}
        onFocus={(e) => {
          const el = e.currentTarget
          editTextareaRef.current = el
          if (pendingCaretRef.current !== null) {
            el.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current)
            pendingCaretRef.current = null
          }
        }}
        initialHeight={editInitialHeight}
      />
    </div>
  )
}
