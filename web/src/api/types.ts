// ---------------------------------------------------------------------------
// Shared API types
// ---------------------------------------------------------------------------

export type StoryPhase = 'setup' | 'kickoff' | 'story'

export interface StoryStats {
  chatRows: number
  icPosts: number
  worldbookRows: number
  lastPlayedAt: string | null
}

export interface Story {
  id: string
  name: string
  parentStoryId: string | null
  hidden: boolean
  createdAt: string
  updatedAt: string
  stats?: StoryStats
}

export interface StoryState {
  phase: StoryPhase
  kickoffPageId: string | null
  currentPageId: string | null
}

export interface LogEntry {
  pageId: string
  textId: string | null
  role: string
  content: string | null
  hidden: boolean
  createdAt: string | null
  genMetrics: string | null
  genExtract: string | null
  compressMetrics: string | null
  icPostNumber: number | null
}

export interface LogPage {
  entries: LogEntry[]
  hasMore: boolean
}

export interface Position {
  currentPageId: string | null
  headPageId: string | null
  atHead: boolean
  canUndo: boolean
  canRedo: boolean
}

export interface GenerationOptions {
  responseLimit?: number
  moodFragment?: string
  paramOverrides?: Record<string, number | undefined>
  modelOverride?: string
  configIdOverride?: string
  effort?: { enableThinking?: boolean; thinkingBudget?: number }
}

export interface Job {
  id: string
  createdAt: string
  targetTextId: string | null
  targetArchiveId: string | null
  jobType: string
  status: string
  priority: number
  slotCost: number
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  model: string | null
  tokenEstimate: number | null
  inputTokenEstimate?: number | null
  elapsedMs: number | null
  resultSummary?: string | null
}

export interface ActiveJob {
  id: string
  createdAt: string
  targetTextId: string | null
  jobType: string
  status: string
  startedAt: string | null
  inputTokenEstimate?: number | null
}

export type JobStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'progress'; label: string }
  | { type: 'meta'; inputTokenEstimate: number }
  | { type: 'reset'; thinking: boolean; text: boolean; label?: string }
  | {
      type: 'sync'
      text: string
      thinking?: string
      progress?: string
      inputTokenEstimate?: number
    }
  | { type: 'done'; fullText: string; followUp?: { jobId: string; pageId: string } }
  | { type: 'error'; message: string }
  | { type: 'cancelled' }

export interface ModelConfig {
  id: string
  userId: string
  provider: 'featherless' | 'horde'
  model: string
  temperature: number
  responseLimit: number
  contextLimit: number
  presencePenalty: number | null
  frequencyPenalty: number | null
  repetitionPenalty: number | null
  topP: number | null
  topK: number | null
  minP: number | null
  concurrencyCost: number | null
  useAuthor: boolean
  useEditor: boolean
  useWorker: boolean
  active: boolean
  sortOrder: number
  successCount: number
  failCount: number
  inputTokens: number
  outputTokens: number
  createdAt: string
  updatedAt: string
}

export type ModelConfigPatch = Partial<
  Omit<
    ModelConfig,
    | 'id'
    | 'userId'
    | 'sortOrder'
    | 'successCount'
    | 'failCount'
    | 'inputTokens'
    | 'outputTokens'
    | 'createdAt'
    | 'updatedAt'
  >
>

export interface CatalogModel {
  id: string
  contextLength?: number
  concurrencyCost?: number
  toolUse?: boolean
}

export type LayoutJustify = 'left' | 'center' | 'right'

export interface LayoutButton {
  id: string
  label?: string
  visible: boolean
}

export interface LayoutContainer {
  id: string
  label?: string
  visible: boolean
  showButton: boolean
  showLabel: boolean
  justify: LayoutJustify
  buttons: LayoutButton[]
}

export interface LayoutRegion {
  containers: LayoutContainer[]
}

export interface LayoutConfigData {
  version: 2
  nav: LayoutRegion
  inputBar: LayoutRegion
}

export interface LayoutConfigResponse {
  id: string | null
  name: string
  config: LayoutConfigData
}

export interface PromptCatalogEntry {
  id: string
  name: string
  usedBy: string
  kind: 'system-prompt' | 'instruction'
  sourceFile: string
  content: string
}

export interface PromptMessage {
  role: string
  content: string
  tokenEstimate: number
  icPostNumber: number | null
  cumulativeTokens: number
}

export interface PromptPreview {
  messages: PromptMessage[]
  totalTokens: number
  usableBudget: number
  storyToDateTriggerAt: number
}

export interface UserProfile {
  id: string
  displayName: string
}

export interface AccountProfile {
  id: string
  displayName: string
  featherlessKeyMasked: string | null
  hordeKeyMasked: string | null
}

export type SupersededReason = 'unclaimed' | 'superseded'

export interface SupersededInfo {
  reason: SupersededReason
  active: { lastSeenAt: string } | null
  stale: { lastSeenAt: string } | null
}

export interface StoryToDateSegment {
  id: string
  kind: 'begins' | 'continues'
  seq: number
  createdAt: string
  content: string | null
  name: string | null
  coverageThroughIcPost: number | null
  coveragePageId: string | null
  hidden: boolean
  broken: boolean
  status: 'ready' | 'pending' | 'broken'
  tokenCount: number | null
  jobActive: boolean
  foldJobActive: boolean
  nameJobActive: boolean
}

export interface ActiveMemoryJob {
  id: string
  jobType: string
  status: 'pending' | 'running'
  createdAt: string
  startedAt: string | null
  targetSegmentId: string | null
}

export interface StoryToDatePage {
  segments: StoryToDateSegment[]
  activeMemoryJobs: ActiveMemoryJob[]
  mergedCoverageThroughPost: number | null
  icPostCount: number
  total: number
  withContent: number
  pending: number
  broken: number
}

export type WorldbookEntryType = 'content' | 'roster' | 'memory'

export interface WorldbookEntry {
  pageId: string
  bookId: string
  entryType: WorldbookEntryType
  hidden: boolean
  broken: boolean
  createdAt: string
  content: string
  currentTextId: string
}

export interface WorldbookCompactResult {
  entries: Array<{
    pageId: string
    entryType: WorldbookEntryType
    beforeTokens: number
    afterTokens: number
    skipped: boolean
  }>
  totalBeforeTokens: number
  totalAfterTokens: number
}
