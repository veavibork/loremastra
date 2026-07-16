import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  continuePost,
  editPost,
  fetchActiveJobs,
  fetchLog,
  fetchPosition,
  forkStory,
  kickoff,
  postMessage,
  postSetupMessage,
  redoPosition,
  retryPost,
  startOocSession,
  streamJob,
  undoPosition,
  type LogEntry,
  type LogPage,
  type Position,
  type StoryPhase,
} from '../api'
import { DEFAULT_INPUT_BAR } from '../lib/layoutUtils'
import { useStoryToggles } from '../components/StoryToggles'
import {
  loadAllReasoningTraces,
  saveReasoningTrace,
  useReasoningDisplayPrefs,
} from '../components/ReasoningDisplay'
import type { LayoutButton, LayoutRegion } from '../api'
import './StoryView.css'
import StoryLog from '../components/StoryLog'
import StoryFooter from '../components/StoryFooter'
import { useStoryMode } from '../store'
import { jobElapsedAnchor } from './StoryViewHelpers'
import { STREAM_HANDLERS, type StreamHandlerCtx } from './streamHandlers'
import type { StoryViewAction } from './StoryViewReducer'
import { initialStoryViewState, storyViewReducer } from './StoryViewReducer'

import { estimatePrefillSeconds } from './syncPendingWaitPhases'

/** Raw entries (both IC and hidden OOC pages) kept loaded at once before "load earlier" is needed. */
const LOG_PAGE_SIZE = 80

/** Nav's tab-based layout unmounts a panel entirely when its column is closed, so plain
 * useState loses which mode (IC/OOC) a story was in the moment the Story tab is reopened —
 * it'd always fall back to the phase-based default below. Restoring from here on mount (and
 * writing to it on every change) means reopening the tab lands back exactly where it was left,
 * with no extra startOocSession call — see handleEnterOoc, which only fires from an explicit
 * toggle click, never from this restore path. */

/**
 * Maps a click's page coordinates to an offset in the *source* content string (not the rendered
 * text — bold/italic markers are stripped on render, see EntryContent's renderInline), so
 * tap-to-edit can drop the cursor where the user actually clicked instead of always at the start.
 * Walks up from whatever DOM node the browser's caret-hit-testing API resolved to until it finds
 * one of EntryContent's data-src-start-tagged spans/strong/em elements, then adds the in-node
 * offset to that span's recorded source-string start. Returns null if the browser lacks both
 * caret-hit-testing APIs (very old browsers) or the click didn't land in a tagged span at all —
 * callers should fall back to "end of content" in that case.
 */
function resolveClickOffset(
  clientX: number,
  clientY: number,
  contentEl: HTMLElement,
): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }
  let node: Node | null = null
  let offset = 0
  if (typeof document.caretRangeFromPoint === 'function') {
    const range = document.caretRangeFromPoint(clientX, clientY)
    if (!range) return null
    node = range.startContainer
    offset = range.startOffset
  } else if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(clientX, clientY)
    if (!pos) return null
    node = pos.offsetNode
    offset = pos.offset
  } else {
    return null
  }
  if (!node || !contentEl.contains(node)) return null

  // Hit-testing usually lands inside a text node (offset = character index within it), but
  // browsers sometimes resolve to an element boundary instead — e.g. clicking below the last
  // line, in the box's padding. There, `offset` is a *child-node index*, not a character count;
  // treating it as one is what caused the cursor to consistently land near the start of whichever
  // span was childNodes[0]. Normalize down to the nearest real text node (its very start or very
  // end, depending on which side of the boundary the click landed) before walking up for a
  // data-src-start-tagged ancestor.
  if (node.nodeType !== Node.TEXT_NODE) {
    const children = node.childNodes
    if (children.length === 0) return null
    const landedAfterLastChild = offset >= children.length
    let child: Node = children[Math.min(offset, children.length - 1)]
    while (child.nodeType !== Node.TEXT_NODE && child.childNodes.length > 0) {
      child = landedAfterLastChild
        ? child.childNodes[child.childNodes.length - 1]
        : child.childNodes[0]
    }
    if (child.nodeType !== Node.TEXT_NODE) return null
    node = child
    offset = landedAfterLastChild ? (child.textContent?.length ?? 0) : 0
  }

  let el: HTMLElement | null = node.parentElement
  while (el && el !== contentEl && el.dataset.srcStart === undefined) {
    el = el.parentElement
  }
  if (!el || el.dataset.srcStart === undefined) return null
  return parseInt(el.dataset.srcStart, 10) + offset
}

export default function StoryView({
  storyId,
  phase,
  onKickedOff,
  inputBar,
  onReorder,
}: {
  storyId: string
  phase: StoryPhase
  onKickedOff?: () => void
  inputBar?: LayoutRegion
  onReorder?: (
    region: 'nav' | 'inputBar',
    containerId: string,
    reorderedButtons: LayoutButton[],
  ) => void
}) {
  const toggles = useStoryToggles(storyId)
  const reasoningPrefs = useReasoningDisplayPrefs()
  const { showReasoning, reasoningExpanded, toggleShowReasoning, toggleReasoningExpanded } =
    reasoningPrefs
  const [state, rawDispatch] = useReducer(storyViewReducer, undefined, initialStoryViewState)
  // Toggle from browser console: window.DEBUG_STORY = true
  const dispatch = (action: StoryViewAction) => {
    if (window.DEBUG_STORY) {
      console.log('[dispatch]', action.type, action)
    }
    rawDispatch(action)
  }
  const {
    entries,
    hasMoreEntries,
    loadingEarlier,
    pendingReplies,
    hiddenPending,
    starting,
    traceCacheVersion,
  } = state
  // streamJob's EventSource outlives the render that created it — without this ref, the sync/done
  // handlers close over a stale pendingReplies snapshot and either drop the snapshot or lose the
  // reasoning trace. The ref is kept in sync on every render so the callback always sees latest.
  const pendingRepliesRef = useRef(pendingReplies)
  pendingRepliesRef.current = pendingReplies

  /** Accumulates thinking text independently of reducer state — PENDING_RESET clears the
   *  reducer's thinking field but not this ref, so the done handler can save the full
   *  reasoning trace even if a display-only reset event arrived between the last token and
   *  done. Cleared when an attempt is genuinely discarded (a reset with thinking:true) or
   *  once the job completes — see streamHandlers.ts's StreamHandlerCtx doc comment. */
  const accumulatedThinkingRef = useRef<Record<string, string>>({})

  /** EventSource cleanup functions keyed by pageId — closed on terminal events (done/error/cancelled)
   *  and on component unmount. Before storing a new cleanup, the prior one is called first, so the
   *  done handler's followUp chain (which calls watchJob for the same pageId) doesn't leak the old
   *  EventSource. */
  const activeConnections = useRef<Map<string, () => void>>(new Map())

  // Close all EventSources on unmount
  useEffect(() => {
    return () => {
      activeConnections.current.forEach((fn) => fn())
      activeConnections.current.clear()
    }
  }, [])
  const reasoningTraces = useMemo(
    () => (showReasoning ? loadAllReasoningTraces(storyId) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- traceCacheVersion is a cache-bust sentinel
    [storyId, showReasoning, traceCacheVersion],
  )
  const toolbarContainers = inputBar?.containers?.length
    ? inputBar.containers
    : DEFAULT_INPUT_BAR.containers
  const [mode, setMode] = useStoryMode(storyId, phase === 'setup' ? 'guide' : 'play')
  const [position, setPosition] = useState<Position | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Keyed by agent pageId so multiple sends can be in flight at once — queued messages each get
  // their own page (and their own streamJob subscription) rather than sharing one slot.
  // startedAt backs the "Thinking… (Ns)" placeholder — anchored to the job's server createdAt /
  // startedAt when reattaching or polling so closing the tab doesn't reset the counter.
  // Tap-to-edit: at most one post editable at a time (see handleLogClick). null means nothing is
  // being edited and every post renders as plain read-only content.
  const [editingPageId, setEditingPageId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editInitialHeight, setEditInitialHeight] = useState<number | undefined>(undefined)
  // Set on focus so the overlay's Delete (forward-delete) button acts on the one box that can
  // possibly be focused — see handleDeleteKey's doc comment for why this uses execCommand.
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Where to drop the cursor once the edit textarea mounts and focuses (see handleLogClick and
  // its onFocus consumer below) — a ref rather than state since it's a one-shot instruction, not
  // something that should trigger its own re-render.
  const pendingCaretRef = useRef<number | null>(null)
  // The Virtuoso scroll container (wired via StoryLog's scrollerRef). Used to hold the log's
  // scroll position steady across the tap-to-edit transition — see the useLayoutEffect below.
  const scrollerRef = useRef<HTMLElement | null>(null)
  // Scroll position captured at click time so the edit transition can restore it.
  const preEditScrollTopRef = useRef<number | null>(null)

  // Hold the log's scroll position steady across the tap-to-edit transition. Entering edit swaps
  // an entry's read-only content for a textarea; that re-measures the item and makes Virtuoso's
  // ResizeObserver re-anchor the viewport (~300-450px) a frame or two after paint. AutoGrowTextarea
  // resizes twice — a synchronous pass then a requestAnimationFrame pass — so the observer fires
  // twice; restore synchronously (keeps the first paint correct) then once per following frame to
  // counter each re-anchor.
  useLayoutEffect(() => {
    if (!editingPageId) return
    const target = preEditScrollTopRef.current
    const sc = scrollerRef.current
    if (target == null || !sc) return
    sc.scrollTop = target
    const raf1 = requestAnimationFrame(() => {
      sc.scrollTop = target
      requestAnimationFrame(() => {
        sc.scrollTop = target
      })
    })
    return () => cancelAnimationFrame(raf1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingPageId])

  /**
   * Only the most recent LOG_PAGE_SIZE raw entries are kept loaded (see loadEarlier) — once
   * something's already loaded, re-fetching from scratch on every action would defeat that, so
   * this re-walks from head only down through whatever was already the oldest loaded entry
   * (refreshing its content too, in case it was just edited) instead of the whole chain.
   */
  async function refresh(): Promise<LogPage> {
    const oldestLoadedPageId = entries[0]?.pageId
    const page = await fetchLog(
      storyId,
      oldestLoadedPageId ? { throughPageId: oldestLoadedPageId } : { limit: LOG_PAGE_SIZE },
    )
    dispatch({ type: 'LOG_REFRESH', entries: page.entries, hasMore: page.hasMore })
    setPosition(await fetchPosition(storyId))
    return page
  }

  async function loadEarlier() {
    if (!hasMoreEntries || loadingEarlier || entries.length === 0) return
    dispatch({ type: 'LOG_LOAD_EARLIER_START' })
    try {
      const page = await fetchLog(storyId, {
        limit: LOG_PAGE_SIZE,
        beforePageId: entries[0].pageId,
      })
      dispatch({ type: 'LOG_PREPEND', entries: page.entries })
      dispatch({ type: 'LOG_LOAD_EARLIER_DONE', hasMore: page.hasMore })
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      dispatch({ type: 'LOG_LOAD_EARLIER_FAIL' })
    }
  }

  /**
   * Undo/redo can rewind to a page older than whatever's currently loaded, since the log only
   * keeps a recent window by default — without this, `shown`'s position-based slice (below) would
   * fail to find currentPageId and fall back to rendering the *entire* loaded window instead of
   * stopping at the real position. Pulls older batches in one at a time until the target page
   * turns up (or there's genuinely nothing older left).
   */
  async function ensurePageLoaded(
    pageId: string | null,
    knownEntries: LogEntry[],
    knownHasMore: boolean,
  ) {
    if (!pageId) return
    let current = knownEntries
    let more = knownHasMore
    const fetchedBatches: LogEntry[][] = []
    while (more && current.length > 0 && !current.some((e) => e.pageId === pageId)) {
      const older = await fetchLog(storyId, {
        limit: LOG_PAGE_SIZE,
        beforePageId: current[0].pageId,
      })
      if (older.entries.length === 0) {
        more = false
        break
      }
      fetchedBatches.unshift(older.entries)
      current = [...older.entries, ...current]
      more = older.hasMore
    }
    if (fetchedBatches.length > 0) dispatch({ type: 'LOG_PREPEND', entries: fetchedBatches.flat() })
    dispatch({ type: 'LOG_LOAD_EARLIER_DONE', hasMore: more })
  }

  /**
   * Finds log entries still mid-generation (agent pages with no content yet) and reattaches to
   * whatever job is producing them. Needed because pendingReplies is plain component state —
   * closing the story tab and reopening it remounts StoryView with an empty pendingReplies, and
   * without this the post would just sit rendered as "…" with no live updates until the job
   * finishes and some unrelated action happens to call refresh(). Deliberately only run once on
   * mount/story-switch (below), not from every refresh() — the in-session action handlers
   * (handleSubmit etc.) already call watchJob themselves for jobs they just created, and
   * pendingReplies state wouldn't reflect that yet here (same-render closure), so calling this
   * from a general refresh() would double-subscribe those jobs.
   */
  async function resumeActiveJobs(freshEntries: LogEntry[]) {
    const unresolved = freshEntries.filter(
      (e) => e.role === 'agent' && e.content === null && e.textId,
    )
    if (unresolved.length === 0) return
    try {
      const jobs = await fetchActiveJobs(storyId)
      for (const entry of unresolved) {
        const job = jobs.find((j) => j.targetTextId === entry.textId)
        if (job) watchJob(job.id, entry.pageId, undefined, jobElapsedAnchor(job))
      }
    } catch (err) {
      console.error('failed to resume active jobs', err)
    }
  }

  useEffect(() => {
    void (async () => {
      const page = await refresh()
      await resumeActiveJobs(page.entries)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resumeActiveJobs changes per render; stable when storyId changes
  }, [storyId])

  // True while anything is generating, from any source (a queued send, kickoff, continue, or
  // retry) — gates the actions that need a stable, fully-resolved history to act on unambiguously
  // (Undo/Redo/Retry/Continue/Fork/Kickoff/Edit). The composer is deliberately NOT gated by this —
  // see the form below — so new messages can keep queuing up while earlier ones (including their
  // worldbook checks) are still resolving.
  const busy = starting || Object.keys(pendingReplies).length > 0

  function watchJob(jobId: string, pageId: string, onDone?: () => void, startedAt?: number) {
    dispatch({ type: 'PENDING_WATCH', pageId, jobId, startedAt: startedAt ?? Date.now() })
    // Close prior connection for this pageId — followUp chains a new watchJob
    // for the same pageId, and the old EventSource must close before the new one opens.
    activeConnections.current.get(pageId)?.()
    const ctx: StreamHandlerCtx = {
      dispatch,
      pendingRef: pendingRepliesRef,
      accumulatedThinkingRef,
      storyId,
      pageId,
      jobId,
      fetchActiveJobs,
      refresh,
      watchJob,
      onDone,
      setError,
      estimatePrefill: estimatePrefillSeconds,
      saveReasoningTrace,
      closeConnection: (pid: string) => {
        activeConnections.current.get(pid)?.()
        activeConnections.current.delete(pid)
      },
    }
    const cleanup = streamJob(storyId, jobId, (event) => {
      if (window.DEBUG_STORY && event.type !== 'token') {
        console.log('[sse]', event.type, event)
      }
      const handler = STREAM_HANDLERS[event.type]
      if (handler) handler(event, ctx)
    })
    activeConnections.current.set(pageId, cleanup)
  }

  /** Shared send-then-stream path used by all four send handlers. */
  async function sendAndWatch(
    apiCall: () => Promise<{ jobId: string; agentPageId?: string }>,
    opts: { starting?: boolean; skipRefresh?: boolean; onDone?: () => void; pageId?: string } = {},
  ) {
    if (opts.starting) dispatch({ type: 'SET_STARTING', value: true })
    setError(null)
    try {
      const { jobId, agentPageId } = await apiCall()
      const targetPageId = opts.pageId ?? agentPageId!
      if (!opts.skipRefresh) await refresh()
      watchJob(jobId, targetPageId, opts.onDone)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
      if (opts.starting) dispatch({ type: 'SET_STARTING', value: false })
    }
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault()
    if (!draft.trim() || editingPageId) return
    const content = draft.trim()
    setDraft('')
    const genOpts = mode === 'play' ? toggles.generationOptions() : undefined
    await sendAndWatch(() =>
      mode === 'guide'
        ? postSetupMessage(storyId, content)
        : postMessage(storyId, content, genOpts),
    )
  }

  async function handleKickoff() {
    await sendAndWatch(() => kickoff(storyId), {
      starting: true,
      onDone: () => {
        setMode('play')
        onKickedOff?.()
      },
    })
  }

  async function handleContinue(guidance?: string) {
    const genOpts = mode === 'play' ? toggles.generationOptions() : undefined
    await sendAndWatch(() => continuePost(storyId, guidance, genOpts), { starting: true })
  }

  async function handleRetry(pageId: string, guidance?: string) {
    const genOpts = mode === 'play' ? toggles.generationOptions() : undefined
    await sendAndWatch(() => retryPost(storyId, pageId, guidance, genOpts), {
      starting: true,
      skipRefresh: true,
      pageId,
    })
  }

  function handleContinueClick() {
    const guidance = draft.trim() || undefined
    setDraft('')
    void handleContinue(guidance)
  }

  function handleRetryClick(pageId: string) {
    const guidance = draft.trim() || undefined
    setDraft('')
    void handleRetry(pageId, guidance)
  }

  /** Delegated on .log rather than a per-entry onClick — a per-entry closure prop would defeat
   * EntryContent's React.memo (a new function reference every render forces a re-render
   * regardless of whether content actually changed), which matters here since every streamed
   * token re-renders the whole list via the pendingReplies effect above. */
  function handleLogClick(e: React.MouseEvent<HTMLDivElement>) {
    if (editingPageId || busy) return
    const contentEl = (e.target as HTMLElement).closest<HTMLElement>('.entry-content')
    if (!contentEl) return
    const entryEl = contentEl.closest<HTMLElement>('.entry')
    const pageId = entryEl?.dataset.pageId
    if (!entryEl || !pageId) return
    const entry = shown.find((en) => en.pageId === pageId)
    if (!entry) return
    const content = entry.content ?? ''
    const clicked = resolveClickOffset(e.clientX, e.clientY, contentEl)
    pendingCaretRef.current =
      clicked !== null ? Math.max(0, Math.min(clicked, content.length)) : content.length

    // Capture the pre-edit scroll position so the restore layout-effect can hold it steady
    // through Virtuoso's re-anchor (see the useLayoutEffect keyed on editingPageId).
    preEditScrollTopRef.current = scrollerRef.current?.scrollTop ?? null

    setEditingPageId(pageId)
    setEditDraft(content)
    setEditInitialHeight(contentEl.offsetHeight)
  }

  function cancelEdit() {
    setEditingPageId(null)
    setEditDraft('')
    setEditInitialHeight(undefined)
    editTextareaRef.current = null
    pendingCaretRef.current = null
  }

  async function saveEdit() {
    const pageId = editingPageId
    if (!pageId) return
    const entry = shown.find((en) => en.pageId === pageId)
    const changed = !!entry && editDraft !== (entry.content ?? '')
    cancelEdit()
    if (changed) {
      try {
        await editPost(storyId, pageId, editDraft)
        await refresh()
      } catch (err) {
        console.error(err)
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  /** Fork acts on the edited text, not the pre-edit persisted content — persist the edit first
   *  (mirroring saveEdit, including its no-op-if-unchanged check) so the fork point actually
   *  reflects what's on screen instead of silently dropping the in-progress edit. Note this
   *  also mutates the original post via editPost before branching, same as clicking Save would. */
  async function forkFromEdit() {
    const pageId = editingPageId
    if (!pageId) return
    await saveEdit()
    await handleFork(pageId)
  }

  /** Performs an actual forward-delete in the single open edit box, bypassing whatever native
   * key-entry UI the platform did or didn't show for the current selection. Routed through
   * execCommand (deprecated but still broadly supported, including Android Chrome) rather than a
   * direct value splice, since only edits made that way register in the browser's own undo stack
   * — a plain state update wouldn't be Ctrl+Z-able the way a real keypress is. */
  function handleDeleteKey() {
    const el = editTextareaRef.current
    if (!el) return
    el.focus()
    const hasSelection = el.selectionStart !== el.selectionEnd
    const handled = document.execCommand(hasSelection ? 'delete' : 'forwardDelete')
    if (handled) {
      setEditDraft(el.value)
      return
    }
    // Fallback for environments without execCommand support — same net result, just not undoable.
    const start = el.selectionStart ?? editDraft.length
    const end = el.selectionEnd ?? editDraft.length
    const next =
      start === end
        ? editDraft.slice(0, start) + editDraft.slice(start + 1)
        : editDraft.slice(0, start) + editDraft.slice(end)
    setEditDraft(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start, start)
    })
  }

  async function handleUndo() {
    try {
      const pos = await undoPosition(storyId)
      setPosition(pos)
      const page = await refresh()
      await ensurePageLoaded(pos.currentPageId, page.entries, page.hasMore)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRedo() {
    try {
      const pos = await redoPosition(storyId)
      setPosition(pos)
      const page = await refresh()
      await ensurePageLoaded(pos.currentPageId, page.entries, page.hasMore)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Every Play→OOC switch post-kickoff marks a fresh session boundary so the Editor's context
   * resets instead of replaying every OOC turn the story has ever had — silently, nothing is
   * added to the log, so there's nothing to refresh. Pre-kickoff setup is already in guide mode
   * by default (from the initial useState above), so this only fires once the story has
   * actually reached story phase.
   */
  async function handleEnterOoc() {
    if (phase !== 'setup') {
      try {
        await startOocSession(storyId)
      } catch (err) {
        console.error(err)
        setError(err instanceof Error ? err.message : String(err))
        return
      }
    }
    setMode('guide')
  }

  async function handleFork(pageId: string) {
    try {
      const forked = await forkStory(storyId, pageId)
      setError(null)
      alert(`Forked as "${forked.name}". Switch stories to play it (Saves UI isn't built yet).`)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const pendingIds = new Set(Object.keys(pendingReplies))
  // Every OOC/setup page is hidden the moment it's created, whether that's the original
  // pre-kickoff conversation or a later resumed one — and no IC page ever is (see
  // POST /:id/setup/messages). So Play/IC and Guide/OOC are exact mirror-opposite filters on the
  // same flag: this is what keeps a resumed OOC chat from also showing the interleaved IC story
  // it now shares a page chain with, and vice versa.
  const visible = entries.filter(
    (e) => (mode === 'play' ? !e.hidden : e.hidden) && !pendingIds.has(e.pageId),
  )
  const currentIdx = position?.currentPageId
    ? visible.findIndex((e) => e.pageId === position.currentPageId)
    : -1
  // Rewound past this point? Don't render what comes after — Redo is the only way forward.
  const shown = currentIdx >= 0 ? visible.slice(0, currentIdx + 1) : visible
  const lastEntry = shown[shown.length - 1]
  const canRetry = !!lastEntry && lastEntry.role === 'agent'
  // Queued sends whose agent page already exists (created synchronously) but hasn't resolved yet —
  // rendered after `shown` in the same relative order they were created, live-updated by whichever
  // are actually streaming right now via pendingReplies.
  const pendingEntries = entries.filter(
    (e) =>
      pendingIds.has(e.pageId) &&
      (mode === 'play' ? !e.hidden : e.hidden) &&
      !hiddenPending.has(e.pageId),
  )

  return (
    <div className="story-view">
      <StoryLog
        onLogClick={handleLogClick}
        hasMoreEntries={hasMoreEntries}
        loadingEarlier={loadingEarlier}
        onLoadEarlier={() => void loadEarlier()}
        scrollerRef={scrollerRef}
        shown={shown}
        editingPageId={editingPageId}
        editDraft={editDraft}
        onEditDraftChange={setEditDraft}
        editInitialHeight={editInitialHeight}
        editTextareaRef={editTextareaRef}
        pendingCaretRef={pendingCaretRef}
        reasoningTraces={reasoningTraces}
        reasoningExpanded={reasoningExpanded}
        showReasoning={showReasoning}
        mode={mode}
        pendingEntries={pendingEntries}
        pendingReplies={pendingReplies}
        storyId={storyId}
        onHiddenPendingAdd={(pageId) => dispatch({ type: 'HIDE_PENDING', pageId })}
      />

      <StoryFooter
        error={error}
        onDismissError={() => setError(null)}
        scrollerRef={scrollerRef}
        editingPageId={editingPageId}
        onSaveEdit={saveEdit}
        onCancelEdit={cancelEdit}
        onForkFromEdit={forkFromEdit}
        onDeleteEdit={handleDeleteKey}
        busy={busy}
        mode={mode}
        phase={phase}
        canRetry={canRetry}
        lastEntryPageId={lastEntry?.pageId}
        onRetry={handleRetryClick}
        onContinue={handleContinueClick}
        onKickoff={handleKickoff}
        onEnterOoc={handleEnterOoc}
        onSetMode={setMode}
        onUndo={handleUndo}
        onRedo={handleRedo}
        position={position}
        toolbarContainers={toolbarContainers}
        toggleLabels={toggles.labels}
        onCycleLength={toggles.cycleLength}
        onCycleMood={toggles.cycleMood}
        onCycleParam={toggles.cycleParam}
        onCycleModel={toggles.cycleModel}
        onCycleEffort={toggles.cycleEffort}
        showReasoning={showReasoning}
        reasoningExpanded={reasoningExpanded}
        onToggleShowReasoning={toggleShowReasoning}
        onToggleReasoningExpanded={toggleReasoningExpanded}
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={handleSubmit}
        onReorder={onReorder}
      />
    </div>
  )
}
