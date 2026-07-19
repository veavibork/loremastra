// Barrel — consumers import from './api' exactly as before.
export {
  API_BASE,
  getSessionId,
  setSessionId,
  getStoredUserId,
  onSuperseded,
  apiFetch,
} from './client.js'

export { fetchUsers, claimSession } from './account.js'

export {
  fetchAccount,
  updateDisplayName,
  changePassword,
  logout,
  setFeatherlessKey,
  clearFeatherlessKey,
  setHordeKey,
  clearHordeKey,
} from './keys.js'

export {
  listStories,
  createStory,
  deleteStory,
  renameStory,
  forkStory,
  fetchPhase,
  fetchLog,
} from './stories.js'

export {
  postMessage,
  retryPost,
  editPost,
  continuePost,
  postSetupMessage,
  kickoff,
  startOocSession,
} from './messages.js'

export {
  fetchStoryToDate,
  backfillStoryToDateNames,
  updateStoryToDateSegment,
  deleteStoryToDateSegment,
  enqueueStoryToDate,
  requeueStoryToDateSegment,
  auditStoryToDateSegment,
} from './story-to-date.js'

export {
  fetchWorldbook,
  createWorldbookEntry,
  updateWorldbookEntry,
  compactWorldbook,
} from './worldbook.js'

export {
  fetchModelConfigs,
  createModelConfig,
  updateModelConfig,
  deleteModelConfig,
  fetchModelCatalog,
  reorderModelConfigs,
} from './agents.js'

export { fetchLayout, updateLayout } from './layout.js'

export { fetchSettingsSpace, saveSettingsSpace, revertSettingsSpace } from './settings.js'

export {
  fetchJobs,
  fetchJob,
  fetchSlots,
  cancelJob,
  panicStopAllJobs,
  fetchActiveJobs,
  streamJob,
  streamStoryEvents,
  type StoryDataEvent,
} from './jobs.js'

export { fetchPosition, undoPosition, redoPosition, jumpToPosition } from './position.js'

export { fetchPrompts, fetchPromptPreview } from './prompts.js'

export type {
  StoryPhase,
  StoryStats,
  Story,
  StoryState,
  LogEntry,
  LogPage,
  Position,
  GenerationOptions,
  Job,
  ActiveJob,
  JobStreamEvent,
  SlotHolder,
  SlotsStatus,
  ModelConfig,
  ModelConfigPatch,
  CatalogModel,
  LayoutJustify,
  LayoutButton,
  LayoutContainer,
  LayoutRegion,
  LayoutConfigData,
  LayoutConfigResponse,
  LayoutCatalog,
  LayoutCatalogEntry,
  PromptCatalogEntry,
  PromptMessage,
  PromptPreview,
  UserProfile,
  AccountProfile,
  SupersededReason,
  SupersededInfo,
  StoryToDateSegment,
  ActiveMemoryJob,
  StoryToDatePage,
  WorldbookEntryType,
  WorldbookEntry,
  WorldbookCompactResult,
} from './types.js'
