import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
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
  type ActiveJob,
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
import type { LayoutRegion } from '../api'
import './StoryView.css'
import StoryLog from '../components/StoryLog'
import StoryFooter from '../components/StoryFooter'
import { useStoryMode } from '../store'
import { jobElapsedAnchor, stableElapsedAnchor } from './StoryViewHelpers'
import type { PendingReply, StoryViewAction } from './StoryViewReducer'
import { initialStoryViewState, storyViewReducer } from './StoryViewReducer'

const MEMORY_JOB_TYPES = new Set(['story-to-date', 'story-to-date-fold'])

/** Raw entries (both IC and hidden OOC pages) kept loaded at once before "load earlier" is needed. */
const LOG_PAGE_SIZE = 80

/** Conservative TTFT guess — intentionally high so early tokens feel like a win. */
function estimatePrefillSeconds(inputTokens: number | null | undefined): number {
  if (!inputTokens || inputTokens <= 0) return 30
  return Math.max(10, Math.min(120, Math.ceil(inputTokens / 200)))
}

function mergeJobMeta(
  pending: PendingReply,
  job: ActiveJob,
): Pick<PendingReply, 'inputTokenEstimate' | 'prefillEstimateSec' | 'runningStartedAt'> {
  const inputTokenEstimate = job.inputTokenEstimate ?? pending.inputTokenEstimate
  const runningStartedAt = job.startedAt
    ? new Date(job.startedAt).getTime()
    : pending.runningStartedAt
  const prefillEstimateSec =
    inputTokenEstimate != null
      ? estimatePrefillSeconds(inputTokenEstimate)
      : pending.prefillEstimateSec
  return { inputTokenEstimate, prefillEstimateSec, runningStartedAt }
}

function isMemoryJobRunning(jobs: ActiveJob[]): boolean {
  return jobs.some((j) => MEMORY_JOB_TYPES.has(j.jobType) && j.status === 'running')
}

function syncPendingWaitPhases(
  prev: Record<string, PendingReply>,
  jobs: ActiveJob[],
): Record<string, PendingReply> {
  const memoryBlocking = isMemoryJobRunning(jobs)
  let changed = false
  const next = { ...prev }

  for (const [pageId, pending] of Object.entries(prev)) {
    if (pending.text || pending.progress) continue
    const proseJob = jobs.find((j) => j.id === pending.jobId)
    if (!proseJob) continue

    const startedAt = stableElapsedAnchor(pending, proseJob)
    const meta = mergeJobMeta(pending, proseJob)

    if (proseJob.status === 'pending' && memoryBlocking) {
      if (pending.waitPhase !== 'memory') {
        next[pageId] = {
          ...pending,
          ...meta,
          waitPhase: 'memory',
          startedAt,
          lastProseStatus: proseJob.status,
        }
        changed = true
      }
      continue
    }

    if (pending.waitPhase === 'memory') {
      const waitPhase = pending.thinking?.trim() ? 'reasoning' : 'prefill'
      next[pageId] = { ...pending, ...meta, waitPhase, startedAt, lastProseStatus: proseJob.status }
      changed = true
      continue
    }

    if (proseJob.status === 'running' && !pending.thinking?.trim() && !pending.text.trim()) {
      const waitPhase = 'prefill'
      if (
        pending.waitPhase !== waitPhase ||
        pending.lastProseStatus !== proseJob.status ||
        pending.startedAt !== startedAt ||
        pending.prefillEstimateSec !== meta.prefillEstimateSec
      ) {
        next[pageId] = {
          ...pending,
          ...meta,
          waitPhase,
          startedAt,
          lastProseStatus: proseJob.status,
        }
        changed = true
      }
      continue
    }

    if (
      proseJob.status === 'running' &&
      pending.text.trim() &&
      pending.waitPhase !== 'generating'
    ) {
      next[pageId] = {
        ...pending,
        ...meta,
        waitPhase: 'generating',
        startedAt,
        lastProseStatus: proseJob.status,
      }
      changed = true
      continue
    }

    if (pending.thinking?.trim() && !pending.text.trim()) {
      if (pending.waitPhase !== 'reasoning' || pending.lastProseStatus !== proseJob.status) {
        next[pageId] = {
          ...pending,
          ...meta,
          waitPhase: 'reasoning',
          startedAt,
          lastProseStatus: proseJob.status,
        }
        changed = true
      }
      continue
    }

    if (!pending.waitPhase) {
      const waitPhase =
        proseJob.status === 'running'
          ? 'prefill'
          : proseJob.status === 'pending'
            ? undefined
            : 'prefill'
      next[pageId] = {
        ...pending,
        ...meta,
        waitPhase: waitPhase ?? pending.waitPhase,
        startedAt,
        lastProseStatus: proseJob.status,
      }
      changed = true
    } else if (
      pending.lastProseStatus !== proseJob.status ||
      pending.startedAt !== startedAt ||
      pending.inputTokenEstimate !== meta.inputTokenEstimate
    ) {
      next[pageId] = { ...pending, ...meta, startedAt, lastProseStatus: proseJob.status }
      changed = true
    }
  }

  return changed ? next : prev
}

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
}: {
  storyId: string
  phase: StoryPhase
  onKickedOff?: () => void
  inputBar?: LayoutRegion
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

  // Featherless gives no signal between "request sent" and "first token" — elapsed time fills
  // that gap. While a prose job is queued behind an archive, poll active jobs and show a
  // distinct label; reset the timer when prose actually starts (running or archive clears).
  const [, forceTick] = useState(0)
  useEffect(() => {
    const waiting = Object.values(pendingReplies).some((p) => !p.text && !p.progress)
    if (!waiting) return

    let cancelled = false

    async function pollQueuePhase() {
      try {
        const jobs = await fetchActiveJobs(storyId)
        if (cancelled) return
        dispatch({
          type: 'PENDING_SYNC',
          pendingReplies: syncPendingWaitPhases(pendingRepliesRef.current, jobs),
        })
      } catch (err) {
        console.error('failed to poll queue phase', err)
      }
    }

    void pollQueuePhase()
    const id = setInterval(() => {
      void pollQueuePhase()
      forceTick((n) => n + 1)
    }, 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [storyId, pendingReplies])

  // True while anything is generating, from any source (a queued send, kickoff, continue, or
  // retry) — gates the actions that need a stable, fully-resolved history to act on unambiguously
  // (Undo/Redo/Retry/Continue/Fork/Kickoff/Edit). The composer is deliberately NOT gated by this —
  // see the form below — so new messages can keep queuing up while earlier ones (including their
  // worldbook checks) are still resolving.
  const busy = starting || Object.keys(pendingReplies).length > 0

  function watchJob(jobId: string, pageId: string, onDone?: () => void, startedAt?: number) {
    dispatch({ type: 'PENDING_WATCH', pageId, jobId, startedAt: startedAt ?? Date.now() })
    streamJob(storyId, jobId, (event) => {
      if (window.DEBUG_STORY && event.type !== 'token') {
        console.log('[sse]', event.type, event)
      }
      if (event.type === 'token') {
        dispatch({ type: 'PENDING_TOKEN', pageId, text: event.text })
      } else if (event.type === 'thinking') {
        dispatch({ type: 'PENDING_THINKING', pageId, thinking: event.text })
      } else if (event.type === 'meta') {
        dispatch({ type: 'PENDING_META', pageId, inputTokenEstimate: event.inputTokenEstimate })
      } else if (event.type === 'reset') {
        dispatch({
          type: 'PENDING_RESET',
          pageId,
          text: !!event.text,
          thinking: !!event.thinking,
          label: event.label,
        })
      } else if (event.type === 'progress') {
        dispatch({ type: 'PENDING_PROGRESS', pageId, label: event.label })
      } else if (event.type === 'sync') {
        // Replay of whatever the job had already produced before this connection opened —
        // sets rather than appends, since it's a full snapshot, not an incremental token.
        const cur = pendingRepliesRef.current[pageId]
        if (cur) {
          const hasText = !!event.text.trim()
          const hasThinking = !!event.thinking?.trim()
          const waitPhase = hasText ? 'generating' : hasThinking ? 'reasoning' : cur.waitPhase
          const prefillEstimateSec =
            event.inputTokenEstimate != null
              ? estimatePrefillSeconds(event.inputTokenEstimate)
              : cur.prefillEstimateSec
          dispatch({
            type: 'PENDING_TEXT_SNAPSHOT',
            pageId,
            text: event.text,
            thinking: event.thinking,
            progress: event.progress,
            inputTokenEstimate: event.inputTokenEstimate,
            prefillEstimateSec,
            waitPhase,
          })
        }
      } else if (event.type === 'done') {
        const cur = pendingRepliesRef.current[pageId]
        if (cur?.thinking?.trim()) {
          saveReasoningTrace(storyId, pageId, cur.thinking)
        }
        // Don't drop the pending entry yet — entries[] still has this page's content as null
        // (refresh() below hasn't landed), so removing it here would flip shown.map's render to
        // its "…" placeholder for one render, collapsing the last post's height and, while
        // pinned to the bottom, getting .log's scrollTop clamped down by the browser — the same
        // mechanism as AutoGrowTextarea's collapse-then-clamp bug, just via a content swap
        // instead of a style change. Keeping the full streamed text on screen until refresh()
        // actually has the real content means the pending→shown handoff never has a gap to fall
        // into in the first place.
        dispatch({ type: 'PENDING_DONE', pageId })
        void refresh()
          .then(() => {
            dispatch({ type: 'PENDING_REMOVE', pageId })
          })
          .catch((err) => {
            console.error('refresh after job done failed', err)
            setError(err instanceof Error ? err.message : String(err))
            dispatch({ type: 'PENDING_REMOVE', pageId })
          })
        // Pre-kickoff setup turns are dual-pass — a second, separate worldbook-authoring
        // message may have been queued as a direct consequence of this one finishing. Chain a
        // watch onto it so it streams in and gets highlighted live, instead of a generic poll.
        if (event.followUp) watchJob(event.followUp.jobId, event.followUp.pageId)
        onDone?.()
      } else if (event.type === 'error') {
        dispatch({ type: 'PENDING_FAIL', pageId })
        setError(event.message)
      } else if (event.type === 'cancelled') {
        dispatch({ type: 'PENDING_CANCELLED', pageId })
      }
    })
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault()
    if (!draft.trim() || editingPageId) return

    const content = draft.trim()
    setDraft('')
    setError(null)

    try {
      const genOpts = mode === 'play' ? toggles.generationOptions() : undefined
      const { jobId, agentPageId } =
        mode === 'guide'
          ? await postSetupMessage(storyId, content)
          : await postMessage(storyId, content, genOpts)
      await refresh()
      watchJob(jobId, agentPageId)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleKickoff() {
    dispatch({ type: 'SET_STARTING', value: true })
    setError(null)
    try {
      const { jobId, agentPageId } = await kickoff(storyId)
      await refresh()
      watchJob(jobId, agentPageId, () => {
        setMode('play')
        onKickedOff?.()
      })
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
      dispatch({ type: 'SET_STARTING', value: false })
    }
  }

  async function handleContinue(guidance?: string) {
    dispatch({ type: 'SET_STARTING', value: true })
    setError(null)
    try {
      const genOpts = mode === 'play' ? toggles.generationOptions() : undefined
      const { jobId, agentPageId } = await continuePost(storyId, guidance, genOpts)
      await refresh()
      watchJob(jobId, agentPageId)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
      dispatch({ type: 'SET_STARTING', value: false })
    }
  }

  async function handleRetry(pageId: string, guidance?: string) {
    dispatch({ type: 'SET_STARTING', value: true })
    setError(null)
    try {
      const genOpts = mode === 'play' ? toggles.generationOptions() : undefined
      const { jobId } = await retryPost(storyId, pageId, guidance, genOpts)
      watchJob(jobId, pageId)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
      dispatch({ type: 'SET_STARTING', value: false })
    }
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

  async function forkFromEdit() {
    const pageId = editingPageId
    if (!pageId) return
    cancelEdit()
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
      />
    </div>
  )
}
