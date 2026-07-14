import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToggleIndices {
  length: number
  mood: number
  param: number
  model: number
  effort: number
}

interface ClientState {
  // App-level
  selectedStoryId: string | null
  openTabs: string[]

  // Reasoning display prefs
  reasoningShow: boolean
  reasoningExpanded: boolean

  // Story-scoped (keyed by storyId)
  storyModes: Record<string, 'guide' | 'play'>
  storyToggles: Record<string, ToggleIndices>
  reasoningTraces: Record<string, Record<string, string>>

  // Container collapse state (keyed by "scope.containerId")
  containerCollapsed: Record<string, boolean>
}

// ---------------------------------------------------------------------------
// One-time migration from old individual localStorage keys → single
// `loremaster.ui` key. Only runs on first load before the new key exists;
// once persisted, the store's own state is the source of truth.
// ---------------------------------------------------------------------------

function readOldKeys(): Partial<ClientState> {
  const get = (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  }
  const parse = <T>(raw: string | null, fallback: T): T => {
    if (!raw) return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  // Scan keys with a prefix → record
  function scanPrefix<T>(prefix: string, parseVal: (raw: string) => T): Record<string, T> {
    const out: Record<string, T> = {}
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith(prefix)) {
          const id = key.slice(prefix.length)
          out[id] = parseVal(localStorage.getItem(key) ?? '')
        }
      }
    } catch {
      /* ignore */
    }
    return out
  }

  const selectedStoryId = get('loremaster.selectedStoryId')
  const openTabs = parse<string[]>(get('loremaster.openTabs'), [])
  const reasoningShow = get('loremaster.reasoning.show') !== 'false'
  const reasoningExpanded = get('loremaster.reasoning.expanded') === 'true'

  const storyModes = scanPrefix<'guide' | 'play'>('loremaster.storyMode.', (raw) => {
    return raw === 'guide' || raw === 'play' ? raw : 'play'
  })
  const storyToggles = scanPrefix<ToggleIndices>('loremaster.storyToggles.', (raw) => {
    const p = JSON.parse(raw) as Partial<ToggleIndices>
    return {
      length: p.length ?? 1,
      mood: p.mood ?? 0,
      param: p.param ?? 0,
      model: p.model ?? 0,
      effort: p.effort ?? 0,
    }
  })
  const reasoningTraces = scanPrefix<Record<string, string>>(
    'loremaster.reasoning.traces.',
    (raw) => JSON.parse(raw),
  )
  const containerCollapsed = scanPrefix<boolean>(
    'loremaster.containerCollapsed.',
    (raw) => raw === 'true',
  )

  return {
    selectedStoryId,
    openTabs,
    reasoningShow,
    reasoningExpanded,
    storyModes,
    storyToggles,
    reasoningTraces,
    containerCollapsed,
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useClientStore = create<ClientState>()(
  persist(
    (): ClientState => ({
      selectedStoryId: null,
      openTabs: [],
      reasoningShow: true,
      reasoningExpanded: false,
      storyModes: {},
      storyToggles: {},
      reasoningTraces: {},
      containerCollapsed: {},
      ...readOldKeys(),
    }),
    {
      name: 'loremaster.ui',
      version: 1,
      // Only persist UI state, not auth (session/user IDs stay in api/client.ts)
      partialize: (state) => ({
        selectedStoryId: state.selectedStoryId,
        openTabs: state.openTabs,
        reasoningShow: state.reasoningShow,
        reasoningExpanded: state.reasoningExpanded,
        storyModes: state.storyModes,
        storyToggles: state.storyToggles,
        reasoningTraces: state.reasoningTraces,
        containerCollapsed: state.containerCollapsed,
      }),
    },
  ),
)

// ---------------------------------------------------------------------------
// Selectors / actions
// ---------------------------------------------------------------------------

export function useSelectedStoryId() {
  return useClientStore((s) => s.selectedStoryId)
}

export function useOpenTabs() {
  return useClientStore((s) => s.openTabs)
}

export function useReasoningPrefs() {
  const show = useClientStore((s) => s.reasoningShow)
  const expanded = useClientStore((s) => s.reasoningExpanded)
  return {
    showReasoning: show,
    reasoningExpanded: expanded,
    toggleShowReasoning: () =>
      useClientStore.setState((s) => ({ reasoningShow: !s.reasoningShow })),
    toggleReasoningExpanded: () =>
      useClientStore.setState((s) => ({ reasoningExpanded: !s.reasoningExpanded })),
  }
}

export function useStoryMode(
  storyId: string,
  fallback: 'guide' | 'play' = 'play',
): ['guide' | 'play', (mode: 'guide' | 'play') => void] {
  const mode = useClientStore((s) => s.storyModes[storyId] ?? fallback)
  const setMode = (next: 'guide' | 'play') =>
    useClientStore.setState((s) => ({ storyModes: { ...s.storyModes, [storyId]: next } }))
  return [mode, setMode]
}

export function useContainerCollapsed(scope: string, containerId: string): [boolean, () => void] {
  const key = `${scope}.${containerId}`
  const collapsed = useClientStore((s) => s.containerCollapsed[key] ?? false)
  const toggle = () =>
    useClientStore.setState((s) => ({
      containerCollapsed: { ...s.containerCollapsed, [key]: !s.containerCollapsed[key] },
    }))
  return [collapsed, toggle]
}

// --- Imperative accessors (for non-hook contexts like saveReasoningTrace) ---

export function getReasoningTraces(storyId: string): Record<string, string> {
  return useClientStore.getState().reasoningTraces[storyId] ?? {}
}

export function setReasoningTrace(storyId: string, pageId: string, thinking: string) {
  const trimmed = thinking.trim()
  if (!trimmed) return
  const state = useClientStore.getState()
  const map = { ...(state.reasoningTraces[storyId] ?? {}) }
  map[pageId] = trimmed
  // Cap at 80 entries per story
  const ids = Object.keys(map)
  if (ids.length > 80) {
    for (const id of ids.slice(0, ids.length - 80)) delete map[id]
  }
  useClientStore.setState({
    reasoningTraces: { ...state.reasoningTraces, [storyId]: map },
  })
}

export function getStoryToggles(storyId: string): ToggleIndices {
  return (
    useClientStore.getState().storyToggles[storyId] ?? {
      length: 1,
      mood: 0,
      param: 0,
      model: 0,
      effort: 0,
    }
  )
}

export function setStoryToggles(storyId: string, indices: ToggleIndices) {
  const state = useClientStore.getState()
  useClientStore.setState({
    storyToggles: { ...state.storyToggles, [storyId]: indices },
  })
}

export function setSelectedStoryId(id: string | null) {
  useClientStore.setState({ selectedStoryId: id })
}

export function setOpenTabs(ids: string[]) {
  useClientStore.setState({ openTabs: ids })
}

export type { ToggleIndices }
