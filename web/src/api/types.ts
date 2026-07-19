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
  agentRole?: 'author' | 'editor' | 'worker' | null
  /** Live wait/retry label while running (memory-wait, provider-busy backoff, model fallback). */
  progress?: string | null
}

/** One held concurrency slot, attributed (src/queue/slots.ts SlotHolder). */
export interface SlotHolder {
  jobId: string
  cost: number
  reservedAt: number
  jobType: string
  agentRole: 'author' | 'editor' | 'worker' | null
  storyId: string
  storyName: string
}

export interface SlotsStatus {
  mode: 'live' | 'fallback'
  used: number
  max: number
  /** Featherless's own account-wide count (live mode) — includes lingering post-abort usage and in-job retries no local job row shows. */
  providerUsedCost: number | null
  reservedCost: number
  holders: SlotHolder[]
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
  | { type: 'queued' }
  | { type: 'prefill'; inputTokenEstimate?: number }

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

export type ProbeShape = 'separate-field' | 'inline-tagged' | 'none-observed'
export type ProbeStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/** Mirror of the backend's ModelFormatProfile (src/inference/format-probe.ts). */
export interface ModelFormatProfile {
  provider: string
  modelId: string
  probedAt: string
  family: string | null
  reasoningFieldName: string | null
  inlineThinkingTag: { open: string; close: string } | null
  shape: ProbeShape
  /** Shape per probe condition — kwargs change the wire format on some models (Qwen3-8B). */
  shapeByCondition: Partial<Record<string, ProbeShape>>
  unmarkedReasoningSuspected: boolean
  thinkingOffSuppresses: boolean | null
  thinkingOnProduces: boolean | null
  thinkingBudgetHonored: boolean | null
  leakTokensSeen: string[]
  finishReasonReliable: boolean
  sane: boolean
  saneReasons: string[]
  callsAttempted: number
  callsSucceeded: number
  notes: string[]
}

/** One row of GET /api/model-profiles — probe-queue state plus the last good profile. */
export interface ModelProfileRow {
  provider: string
  modelId: string
  requestedBy: string
  status: ProbeStatus
  profile: ModelFormatProfile | null
  probedAt: string | null
  artifactDir: string | null
  error: string | null
  createdAt: string
  updatedAt: string
  /** Live per-condition label while the probe is running ("Probe 3/8: thinking-on run 1…"). */
  progress: string | null
  /** HF model-card tags from the offline cache — read-time enrichment, empty when unsynced. */
  hfTags: string[]
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

export interface LayoutCatalogEntry {
  id: string
  label: string
}

/** Every button the layout editor offers, per region — server-provided so ids never go stale. */
export interface LayoutCatalog {
  nav: LayoutCatalogEntry[]
  inputBar: LayoutCatalogEntry[]
}

export interface LayoutConfigResponse {
  id: string | null
  name: string
  config: LayoutConfigData
  /** Present on GET; PATCH responses omit it. */
  catalog?: LayoutCatalog
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
  auditJobActive: boolean
  /** Coverage-audit verdict — null: never audited (or content changed since). */
  auditVerdict: 'pass' | 'flagged' | null
  auditMissing: string[] | null
  auditAt: string | null
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
