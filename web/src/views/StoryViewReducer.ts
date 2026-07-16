import type { LogEntry } from '../api'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingReply {
  text: string
  thinking?: string
  progress?: string
  startedAt: number
  jobId: string
  inputTokenEstimate?: number
  prefillEstimateSec?: number
  /** When the worker claimed the job — prefill countdown starts here, not at send time. */
  runningStartedAt?: number
  /** Tracks queue wait, prefill, reasoning, and prose for elapsed-time labels. */
  waitPhase?: 'memory' | 'prefill' | 'reasoning' | 'generating'
  lastProseStatus?: string
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface StoryViewState {
  // Log window
  entries: LogEntry[]
  hasMoreEntries: boolean
  loadingEarlier: boolean
  // Streaming
  pendingReplies: Record<string, PendingReply>
  hiddenPending: Set<string>
  starting: boolean
  traceCacheVersion: number
}

export function initialStoryViewState(): StoryViewState {
  return {
    entries: [],
    hasMoreEntries: false,
    loadingEarlier: false,
    pendingReplies: {},
    hiddenPending: new Set(),
    starting: false,
    traceCacheVersion: 0,
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type StoryViewAction =
  // Log window
  | { type: 'LOG_REFRESH'; entries: LogEntry[]; hasMore: boolean }
  | { type: 'LOG_PREPEND'; entries: LogEntry[] }
  | { type: 'LOG_LOAD_EARLIER_START' }
  | { type: 'LOG_LOAD_EARLIER_DONE'; hasMore: boolean }
  | { type: 'LOG_LOAD_EARLIER_FAIL' }

  // Streaming — pending reply lifecycle
  | { type: 'PENDING_WATCH'; pageId: string; jobId: string; startedAt: number }
  | { type: 'PENDING_TOKEN'; pageId: string; text: string }
  | { type: 'PENDING_THINKING'; pageId: string; thinking: string }
  | {
      type: 'PENDING_META'
      pageId: string
      inputTokenEstimate?: number | null
      prefillEstimateSec?: number
      runningStartedAt?: number
    }
  | { type: 'PENDING_RESET'; pageId: string; text: boolean; thinking: boolean; label?: string }
  | { type: 'PENDING_PROGRESS'; pageId: string; label: string | undefined }
  | {
      type: 'PENDING_TEXT_SNAPSHOT'
      pageId: string
      text: string
      thinking: string | undefined
      progress: string | undefined
      inputTokenEstimate?: number | null
      prefillEstimateSec?: number
      waitPhase: PendingReply['waitPhase']
    }
  | { type: 'PENDING_DONE'; pageId: string }
  | { type: 'PENDING_REMOVE'; pageId: string }
  | { type: 'PENDING_FAIL'; pageId: string }
  | { type: 'PENDING_CANCELLED'; pageId: string }
  | { type: 'HIDE_PENDING'; pageId: string }

  // Trace cache
  | { type: 'TRACE_CACHE_BUMP' }
  // Starting / busy guard
  | { type: 'SET_STARTING'; value: boolean }

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Immutable helper: removes a key from hiddenPending and returns a new Set. */
function withoutHidden(hidden: Set<string>, pageId: string): Set<string> {
  if (!hidden.has(pageId)) return hidden
  const next = new Set(hidden)
  next.delete(pageId)
  return next
}

export function storyViewReducer(state: StoryViewState, action: StoryViewAction): StoryViewState {
  switch (action.type) {
    // ---- Log window ----
    case 'LOG_REFRESH':
      return { ...state, entries: action.entries, hasMoreEntries: action.hasMore }

    case 'LOG_PREPEND':
      return { ...state, entries: [...action.entries, ...state.entries] }

    case 'LOG_LOAD_EARLIER_START':
      return { ...state, loadingEarlier: true }

    case 'LOG_LOAD_EARLIER_DONE':
      return { ...state, loadingEarlier: false, hasMoreEntries: action.hasMore }

    case 'LOG_LOAD_EARLIER_FAIL':
      return { ...state, loadingEarlier: false }

    // ---- Streaming — pending reply lifecycle ----
    case 'PENDING_WATCH': {
      // Reconnecting to a page that already has an in-flight reply (error-reattach, or a resumed
      // job): keep the accumulated text/thinking/progress and the original startedAt, only swapping
      // in the (re)watched jobId. Blanking it here would flash the post empty and reset the elapsed
      // counter to zero mid-generation; the reopened stream reconciles the real content via `sync`.
      // Only a genuinely new page (no existing reply) starts from a blank reply.
      const existing = state.pendingReplies[action.pageId]
      return {
        ...state,
        pendingReplies: {
          ...state.pendingReplies,
          [action.pageId]: existing
            ? { ...existing, jobId: action.jobId }
            : { text: '', startedAt: action.startedAt, jobId: action.jobId },
        },
      }
    }

    case 'PENDING_TOKEN': {
      const cur = state.pendingReplies[action.pageId]
      if (!cur) return state
      return {
        ...state,
        pendingReplies: {
          ...state.pendingReplies,
          [action.pageId]: {
            ...cur,
            text: cur.text + action.text,
            waitPhase: 'generating' as const,
            progress: undefined,
          },
        },
      }
    }

    case 'PENDING_THINKING': {
      const cur = state.pendingReplies[action.pageId]
      if (!cur) return state
      return {
        ...state,
        pendingReplies: {
          ...state.pendingReplies,
          [action.pageId]: {
            ...cur,
            thinking: (cur.thinking ?? '') + action.thinking,
            waitPhase: cur.text.trim() ? 'generating' : ('reasoning' as const),
            progress: undefined,
          },
        },
      }
    }

    case 'PENDING_META': {
      const cur = state.pendingReplies[action.pageId]
      if (!cur) return state
      const inputTokenEstimate = action.inputTokenEstimate ?? cur.inputTokenEstimate
      const prefillEstimateSec =
        inputTokenEstimate != null ? Math.ceil((inputTokenEstimate * 1.5) / 1000) : 40 // conservative default
      const waitPhase =
        cur.text.trim() || cur.thinking?.trim() ? cur.waitPhase : (cur.waitPhase ?? 'prefill')
      return {
        ...state,
        pendingReplies: {
          ...state.pendingReplies,
          [action.pageId]: {
            ...cur,
            inputTokenEstimate,
            prefillEstimateSec,
            waitPhase,
            lastProseStatus: 'running' as const,
          },
        },
      }
    }

    case 'PENDING_RESET': {
      const cur = state.pendingReplies[action.pageId]
      if (!cur) return state
      const next: PendingReply = { ...cur }
      if (action.thinking) {
        next.thinking = undefined
        next.waitPhase = next.text.trim() ? 'generating' : ('prefill' as const)
      }
      if (action.text) next.text = ''
      if (action.label) next.progress = action.label
      else if (action.thinking || action.text) next.progress = undefined
      return { ...state, pendingReplies: { ...state.pendingReplies, [action.pageId]: next } }
    }

    case 'PENDING_PROGRESS': {
      const cur = state.pendingReplies[action.pageId]
      if (!cur) return state
      return {
        ...state,
        pendingReplies: {
          ...state.pendingReplies,
          [action.pageId]: { ...cur, progress: action.label },
        },
      }
    }

    case 'PENDING_TEXT_SNAPSHOT': {
      const cur = state.pendingReplies[action.pageId]
      if (!cur) return state
      return {
        ...state,
        pendingReplies: {
          ...state.pendingReplies,
          [action.pageId]: {
            ...cur,
            text: action.text,
            thinking: action.thinking ?? cur.thinking,
            progress: action.progress ?? cur.progress,
            inputTokenEstimate: action.inputTokenEstimate ?? cur.inputTokenEstimate,
            prefillEstimateSec: action.prefillEstimateSec ?? cur.prefillEstimateSec,
            waitPhase: action.waitPhase,
          },
        },
      }
    }

    case 'PENDING_DONE':
      return {
        ...state,
        hiddenPending: withoutHidden(state.hiddenPending, action.pageId),
        traceCacheVersion: state.traceCacheVersion + 1,
      }

    case 'PENDING_REMOVE': {
      const { [action.pageId]: _done, ...rest } = state.pendingReplies
      return { ...state, pendingReplies: rest, starting: false }
    }

    case 'PENDING_FAIL':
    case 'PENDING_CANCELLED': {
      const { [action.pageId]: _failed, ...rest } = state.pendingReplies
      return {
        ...state,
        pendingReplies: rest,
        hiddenPending: withoutHidden(state.hiddenPending, action.pageId),
        starting: false,
      }
    }

    case 'HIDE_PENDING':
      return {
        ...state,
        hiddenPending: new Set(state.hiddenPending).add(action.pageId),
      }

    case 'SET_STARTING':
      return { ...state, starting: action.value }

    case 'TRACE_CACHE_BUMP':
      return { ...state, traceCacheVersion: state.traceCacheVersion + 1 }

    default:
      return state
  }
}
