// Relative on purpose: same-origin in prod (Caddy proxies /api to the backend),
// and in dev the Vite proxy below forwards /api to the local backend.
export const API_BASE = "";
const SESSION_STORAGE_KEY = "loremaster.sessionId";
const USER_STORAGE_KEY = "loremaster.userId";

export function getSessionId(): string | null {
  return localStorage.getItem(SESSION_STORAGE_KEY);
}

export function setSessionId(id: string): void {
  localStorage.setItem(SESSION_STORAGE_KEY, id);
}

export function getStoredUserId(): string | null {
  return localStorage.getItem(USER_STORAGE_KEY);
}

export interface UserProfile {
  id: string;
  displayName: string;
}

/** Guard-exempt (GET only) — the picker needs this before any session exists. */
export async function fetchUsers(): Promise<UserProfile[]> {
  const res = await fetch(`${API_BASE}/api/users`);
  return res.json();
}

/**
 * Deliberately raw fetch, not apiFetch — this route is guard-exempt server-side
 * (src/routes/sessions.ts), and attaching a soon-to-be-invalidated old session header
 * here would be pointless. Keeps the exemption visible in client code too, not just the
 * server's.
 */
export async function claimSession(userId: string, password: string): Promise<{ sessionId: string; claimedAt: string }> {
  const res = await fetch(`${API_BASE}/api/sessions/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, password }),
  });
  const data = (await res.json()) as { sessionId?: string; claimedAt?: string; error?: string };
  if (!data.sessionId) throw new Error(data.error ?? "claim failed");
  setSessionId(data.sessionId);
  localStorage.setItem(USER_STORAGE_KEY, userId);
  return { sessionId: data.sessionId, claimedAt: data.claimedAt! };
}

export type SupersededReason = "unclaimed" | "superseded";

export interface SupersededInfo {
  reason: SupersededReason;
  active: { lastSeenAt: string } | null;
  stale: { lastSeenAt: string } | null;
}

type SupersededListener = (info: SupersededInfo) => void;
const supersededListeners: SupersededListener[] = [];

/** App.tsx subscribes once at the top level — any 409 from anywhere (including a background poll deep inside some view) flips the whole app to the claim screen through this one channel, no per-view wiring needed. */
export function onSuperseded(listener: SupersededListener): () => void {
  supersededListeners.push(listener);
  return () => {
    const i = supersededListeners.indexOf(listener);
    if (i !== -1) supersededListeners.splice(i, 1);
  };
}

/**
 * Every call in this file (except claimSession, which is deliberately guard-exempt)
 * routes through here so the session header and "you've been superseded" handling live
 * in exactly one place rather than threaded through ~40 call sites individually. Throws
 * on a 409 so a caller's normal .then()/await chain never mistakes a rejection payload
 * for real data — App.tsx's bootstrap already expects and swallows that via try/catch.
 */
async function apiFetch(path: string, init: RequestInit = {}, opts?: { background?: boolean }): Promise<Response> {
  const sessionId = getSessionId();
  const headers = new Headers(init.headers);
  if (sessionId) headers.set("X-Loremaster-Session", sessionId);
  if (opts?.background) headers.set("X-Loremaster-Interaction", "background");

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch (err) {
    console.error(`apiFetch: ${path} unreachable —`, err);
    throw err;
  }
  if (res.status >= 500) {
    console.error(`apiFetch: ${path} returned ${res.status}`);
    // Framework-level error pages (e.g. an unhandled exception's default response) aren't
    // necessarily JSON — surface a clean Error here instead of letting every call site's own
    // res.json() crash on it with a confusing "unexpected character" parse error.
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      // not JSON — use the raw text as-is
    }
    throw new Error(message || `request failed (${res.status})`);
  }
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as Partial<SupersededInfo> & { error?: string };
    // The session guard is the only thing that reports "unclaimed"/"superseded" — every other
    // 409 in this app (e.g. "this job type can't be cancelled mid-generation") is a normal
    // business-logic conflict from the route itself, not a session change. Treating every 409
    // as a supersede signal used to send the whole app to the claim-gate screen just from
    // clicking Stop on a job that can't be cancelled mid-flight (compress/archive/Horde).
    if (body.error === "unclaimed" || body.error === "superseded") {
      const info: SupersededInfo = {
        reason: body.error,
        active: body.active ?? null,
        stale: body.stale ?? null,
      };
      for (const listener of supersededListeners) listener(info);
      throw new Error(`session ${info.reason}`);
    }
    throw new Error(body.error || `request failed (${res.status})`);
  }
  return res;
}

export interface AccountProfile {
  id: string;
  displayName: string;
  featherlessKeyMasked: string | null;
  hordeKeyMasked: string | null;
}

export async function fetchAccount(): Promise<AccountProfile> {
  const res = await apiFetch(`/api/account`);
  return res.json();
}

export async function updateDisplayName(displayName: string): Promise<AccountProfile> {
  const res = await apiFetch(`/api/account/display-name`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await apiFetch(`/api/account/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
}

type KeyFields = Pick<AccountProfile, "featherlessKeyMasked" | "hordeKeyMasked">;

export async function setFeatherlessKey(key: string): Promise<KeyFields> {
  const res = await apiFetch(`/api/account/featherless-key`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function clearFeatherlessKey(): Promise<KeyFields> {
  const res = await apiFetch(`/api/account/featherless-key`, { method: "DELETE" });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function setHordeKey(key: string): Promise<KeyFields> {
  const res = await apiFetch(`/api/account/horde-key`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function clearHordeKey(): Promise<KeyFields> {
  const res = await apiFetch(`/api/account/horde-key`, { method: "DELETE" });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export interface StoryStats {
  chatRows: number;
  worldbookRows: number;
  lastPlayedAt: string | null;
}

export interface Story {
  id: string;
  name: string;
  parentStoryId: string | null;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
  stats?: StoryStats;
}

export type LayoutJustify = "left" | "center" | "right";

export interface LayoutButton {
  id: string;
  label?: string;
  visible: boolean;
}

export interface LayoutContainer {
  id: string;
  label?: string;
  visible: boolean;
  showButton: boolean;
  showLabel: boolean;
  justify: LayoutJustify;
  buttons: LayoutButton[];
}

export interface LayoutRegion {
  containers: LayoutContainer[];
}

export interface LayoutConfigData {
  version: 2;
  nav: LayoutRegion;
  inputBar: LayoutRegion;
}

/** @deprecated v1 — server migrates on load. */
export interface LayoutTab {
  id: string;
  label: string;
}

export interface LayoutConfigResponse {
  id: string | null;
  name: string;
  config: LayoutConfigData;
}

export async function fetchLayout(): Promise<LayoutConfigResponse> {
  const res = await apiFetch(`/api/layout`);
  return res.json();
}

export async function updateLayout(config: LayoutConfigData): Promise<LayoutConfigResponse> {
  const res = await apiFetch(`/api/layout`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

/** Generic Settings-tab JSON space storage — see src/routes/settings-spaces.ts. */
export async function fetchSettingsSpace<T>(space: string): Promise<T> {
  const res = await apiFetch(`/api/settings/${space}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.value as T;
}

export async function saveSettingsSpace<T>(space: string, value: T): Promise<T> {
  const res = await apiFetch(`/api/settings/${space}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.value as T;
}

export async function revertSettingsSpace<T>(space: string): Promise<T> {
  const res = await apiFetch(`/api/settings/${space}/revert`, { method: "POST" });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.value as T;
}

export interface Job {
  id: string;
  createdAt: string;
  targetTextId: string | null;
  targetArchiveId: string | null;
  jobType: string;
  status: string;
  priority: number;
  slotCost: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  model: string | null;
  tokenEstimate: number | null;
  elapsedMs: number | null;
}

export interface GenerationOptions {
  responseLimit?: number;
  moodFragment?: string;
  paramOverrides?: Record<string, number | undefined>;
  modelOverride?: string;
  configIdOverride?: string;
  effort?: { enableThinking?: boolean; thinkingBudget?: number };
}

export interface PromptCatalogEntry {
  id: string;
  name: string;
  usedBy: string;
  kind: "system-prompt" | "instruction";
  sourceFile: string;
  content: string;
}

export async function fetchPrompts(): Promise<PromptCatalogEntry[]> {
  const res = await apiFetch(`/api/prompts`);
  const data = (await res.json()) as { prompts: PromptCatalogEntry[] };
  return data.prompts;
}

export async function fetchJobs(storyId: string, opts?: { background?: boolean }): Promise<Job[]> {
  const res = await apiFetch(`/api/stories/${storyId}/jobs`, {}, opts);
  const data = (await res.json()) as { jobs: Job[] };
  return data.jobs;
}

export async function fetchSlots(opts?: { background?: boolean }): Promise<{ used: number; max: number }> {
  const res = await apiFetch(`/api/debug/slots`, {}, opts);
  return res.json();
}

export interface PromptMessage {
  role: string;
  content: string;
}

export async function fetchPromptPreview(
  storyId: string,
  opts?: { background?: boolean }
): Promise<PromptMessage[]> {
  const res = await apiFetch(`/api/stories/${storyId}/prompt-preview`, {}, opts);
  const data = (await res.json()) as { messages: PromptMessage[] };
  return data.messages;
}

export interface ModelConfig {
  id: string;
  userId: string;
  provider: "featherless" | "horde";
  model: string;
  temperature: number;
  responseLimit: number;
  contextLimit: number;
  presencePenalty: number | null;
  frequencyPenalty: number | null;
  repetitionPenalty: number | null;
  topP: number | null;
  topK: number | null;
  minP: number | null;
  concurrencyCost: number | null;
  useAuthor: boolean;
  useEditor: boolean;
  useWorker: boolean;
  active: boolean;
  sortOrder: number;
  successCount: number;
  failCount: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  updatedAt: string;
}

export type ModelConfigPatch = Partial<
  Omit<ModelConfig, "id" | "userId" | "sortOrder" | "successCount" | "failCount" | "inputTokens" | "outputTokens" | "createdAt" | "updatedAt">
>;

export async function fetchModelConfigs(): Promise<ModelConfig[]> {
  const res = await apiFetch(`/api/agents`);
  const data = (await res.json()) as { configs: ModelConfig[] };
  return data.configs;
}

export async function createModelConfig(): Promise<ModelConfig> {
  const res = await apiFetch(`/api/agents`, { method: "POST" });
  const data = (await res.json()) as { config: ModelConfig };
  return data.config;
}

export async function updateModelConfig(id: string, patch: ModelConfigPatch): Promise<ModelConfig> {
  const res = await apiFetch(`/api/agents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.config;
}

export async function deleteModelConfig(id: string): Promise<void> {
  const res = await apiFetch(`/api/agents/${id}`, { method: "DELETE" });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
}

export interface CatalogModel {
  id: string;
  contextLength?: number;
  concurrencyCost?: number;
  toolUse?: boolean;
}

export async function fetchModelCatalog(provider: string): Promise<CatalogModel[]> {
  const res = await apiFetch(`/api/agents/models?provider=${encodeURIComponent(provider)}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.models;
}

export async function reorderModelConfigs(orderedIds: string[]): Promise<ModelConfig[]> {
  const res = await apiFetch(`/api/agents/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderedIds }),
  });
  const data = (await res.json()) as { configs: ModelConfig[] };
  return data.configs;
}

export async function renameStory(storyId: string, name: string): Promise<void> {
  const res = await apiFetch(`/api/stories/${storyId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
}

export interface LogEntry {
  pageId: string;
  textId: string | null;
  role: string;
  content: string | null;
  hidden: boolean;
  createdAt: string | null;
  genMetrics: string | null;
  genExtract: string | null;
  compressMetrics: string | null;
}

export type StoryPhase = "setup" | "kickoff" | "story";

export interface StoryState {
  phase: StoryPhase;
  kickoffPageId: string | null;
  currentPageId: string | null;
}

export async function fetchPhase(storyId: string): Promise<StoryState> {
  const res = await apiFetch(`/api/stories/${storyId}/phase`);
  return res.json();
}

export async function postSetupMessage(
  storyId: string,
  content: string
): Promise<{ jobId: string; agentPageId: string }> {
  const res = await apiFetch(`/api/stories/${storyId}/setup/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

/** One-shot: generates the opening post and moves the story into story phase immediately. */
export async function kickoff(storyId: string): Promise<{ agentPageId: string; jobId: string }> {
  const res = await apiFetch(`/api/stories/${storyId}/kickoff`, { method: "POST" });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

/** Marks a fresh post-kickoff OOC "update session" boundary — no page created, nothing new in the log. */
export async function startOocSession(storyId: string): Promise<void> {
  const res = await apiFetch(`/api/stories/${storyId}/ooc/start-session`, { method: "POST" });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
}

export async function listStories(): Promise<Story[]> {
  const res = await apiFetch(`/api/stories`);
  const data = (await res.json()) as { stories: Story[] };
  return data.stories;
}

export async function createStory(name: string): Promise<Story> {
  const res = await apiFetch(`/api/stories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = (await res.json()) as { story: Story };
  return data.story;
}

export async function deleteStory(storyId: string): Promise<void> {
  const res = await apiFetch(`/api/stories/${storyId}`, { method: "DELETE" });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
}

export async function fetchLog(storyId: string, opts?: { background?: boolean }): Promise<LogEntry[]> {
  const res = await apiFetch(`/api/stories/${storyId}/log`, {}, opts);
  const data = (await res.json()) as { entries: LogEntry[] };
  return data.entries;
}

export interface StoryToDateSegment {
  id: string;
  kind: "begins" | "continues";
  seq: number;
  createdAt: string;
  content: string | null;
  name: string | null;
  coverageThroughIcPost: number | null;
  coveragePageId: string | null;
  hidden: boolean;
  broken: boolean;
  status: "ready" | "pending" | "broken";
  tokenCount: number | null;
  jobActive: boolean;
  nameJobActive: boolean;
}

export interface StoryToDatePage {
  segments: StoryToDateSegment[];
  mergedCoverageThroughPost: number | null;
  total: number;
  withContent: number;
  pending: number;
  broken: number;
}

export async function fetchStoryToDate(
  storyId: string,
  options: { background?: boolean } = {}
): Promise<StoryToDatePage> {
  const res = await apiFetch(`/api/stories/${storyId}/story-to-date`, {}, { background: options.background });
  return res.json() as Promise<StoryToDatePage>;
}

export async function backfillStoryToDateNames(storyId: string): Promise<StoryToDatePage> {
  const res = await apiFetch(`/api/stories/${storyId}/story-to-date/backfill-names`, { method: "POST" });
  const data = (await res.json()) as { view: StoryToDatePage; error?: string };
  if (data.error) throw new Error(data.error);
  return data.view;
}

export async function updateStoryToDateSegment(
  storyId: string,
  segmentId: string,
  patch: { content?: string; name?: string }
): Promise<StoryToDatePage> {
  const res = await apiFetch(`/api/stories/${storyId}/story-to-date/${segmentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = (await res.json()) as { view: StoryToDatePage; error?: string };
  if (data.error) throw new Error(data.error);
  return data.view;
}

export async function enqueueStoryToDate(storyId: string): Promise<StoryToDatePage> {
  const res = await apiFetch(`/api/stories/${storyId}/story-to-date/enqueue`, { method: "POST" });
  const data = (await res.json()) as { view: StoryToDatePage; error?: string };
  if (data.error) throw new Error(data.error);
  return data.view;
}

export async function requeueStoryToDateSegment(storyId: string, segmentId: string): Promise<StoryToDatePage> {
  const res = await apiFetch(`/api/stories/${storyId}/story-to-date/${segmentId}/requeue`, { method: "POST" });
  const data = (await res.json()) as { view: StoryToDatePage; error?: string };
  if (data.error) throw new Error(data.error);
  return data.view;
}

/** @deprecated decad archives removed — use StoryToDateSegment */
export interface ArchiveEntry {
  id: string | null;
  createdAt: string | null;
  summary: string | null;
  name: string | null;
  hidden: boolean;
  broken: boolean;
  memberCount: number;
  startIndex: number;
  endIndex: number;
  startPageId: string;
  endPageId: string;
  status: "ready" | "pending" | "broken" | "missing";
  queueEligible: boolean;
  proseMissingPostNumbers: number[];
  proseEmptyPostNumbers: number[];
  archiveJobActive: boolean;
  nameJobActive: boolean;
}

export interface ArchivePage {
  archives: ArchiveEntry[];
  total: number;
  withSummary: number;
  pending: number;
  broken: number;
  missingRows: number;
}

export async function fetchArchives(
  storyId: string,
  options: { includeHidden?: boolean; background?: boolean } = {}
): Promise<ArchivePage> {
  const params = new URLSearchParams();
  if (options.includeHidden) params.set("includeHidden", "true");
  const qs = params.toString();
  const res = await apiFetch(`/api/stories/${storyId}/archives${qs ? `?${qs}` : ""}`, {}, { background: options.background });
  return res.json() as Promise<ArchivePage>;
}

export async function backfillArchiveNames(storyId: string): Promise<ArchivePage> {
  const res = await apiFetch(`/api/stories/${storyId}/archives/backfill-names`, { method: "POST" });
  const data = (await res.json()) as { view: ArchivePage; error?: string };
  if (data.error) throw new Error(data.error);
  return data.view;
}

export async function queueArchiveDecad(storyId: string, startIndex: number): Promise<ArchivePage> {
  const res = await apiFetch(`/api/stories/${storyId}/archives/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ startIndex }),
  });
  const data = (await res.json()) as { view: ArchivePage; error?: string };
  if (data.error) throw new Error(data.error);
  return data.view;
}

export async function updateArchive(
  storyId: string,
  archiveId: string,
  patch: { summary?: string; name?: string }
): Promise<ArchivePage> {
  const res = await apiFetch(`/api/stories/${storyId}/archives/${archiveId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = (await res.json()) as { view: ArchivePage; error?: string };
  if (data.error) throw new Error(data.error);
  return data.view;
}

export async function requeueArchive(storyId: string, archiveId: string): Promise<ArchivePage> {
  const res = await apiFetch(`/api/stories/${storyId}/archives/${archiveId}/requeue`, { method: "POST" });
  const data = (await res.json()) as { view: ArchivePage; error?: string };
  if (data.error) throw new Error(data.error);
  return data.view;
}

export async function postMessage(
  storyId: string,
  content: string,
  generationOptions?: GenerationOptions
): Promise<{ jobId: string; agentPageId: string }> {
  const res = await apiFetch(`/api/stories/${storyId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, generationOptions }),
  });
  return res.json();
}

export async function retryPost(
  storyId: string,
  pageId: string,
  guidance?: string,
  generationOptions?: GenerationOptions
): Promise<{ jobId: string; textId: string }> {
  const res = await apiFetch(`/api/stories/${storyId}/posts/${pageId}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guidance, generationOptions }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function editPost(storyId: string, pageId: string, content: string): Promise<void> {
  const res = await apiFetch(`/api/stories/${storyId}/posts/${pageId}/edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
}

export async function continuePost(
  storyId: string,
  guidance?: string,
  generationOptions?: GenerationOptions
): Promise<{ agentPageId: string; jobId: string }> {
  const res = await apiFetch(`/api/stories/${storyId}/continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guidance, generationOptions }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export interface Position {
  currentPageId: string | null;
  headPageId: string | null;
  atHead: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export async function fetchPosition(storyId: string): Promise<Position> {
  const res = await apiFetch(`/api/stories/${storyId}/position`);
  return res.json();
}

export async function undoPosition(storyId: string): Promise<Position> {
  const res = await apiFetch(`/api/stories/${storyId}/position/undo`, { method: "POST" });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function redoPosition(storyId: string): Promise<Position> {
  const res = await apiFetch(`/api/stories/${storyId}/position/redo`, { method: "POST" });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function jumpToPosition(storyId: string, pageId: string): Promise<Position> {
  const res = await apiFetch(`/api/stories/${storyId}/position`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pageId }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function forkStory(storyId: string, pageId?: string, name?: string): Promise<Story> {
  const res = await apiFetch(`/api/stories/${storyId}/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pageId, name }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.story;
}

export type WorldbookEntryType = "content" | "roster" | "memory";

export interface WorldbookEntry {
  pageId: string;
  bookId: string;
  entryType: WorldbookEntryType;
  hidden: boolean;
  broken: boolean;
  createdAt: string;
  content: string;
  currentTextId: string;
}

export async function fetchWorldbook(storyId: string, opts?: { background?: boolean }): Promise<WorldbookEntry[]> {
  const res = await apiFetch(`/api/stories/${storyId}/worldbook`, {}, opts);
  const data = (await res.json()) as { entries: WorldbookEntry[] };
  return data.entries;
}

export async function createWorldbookEntry(
  storyId: string,
  input: { entryType: WorldbookEntryType; content: string }
): Promise<WorldbookEntry> {
  const res = await apiFetch(`/api/stories/${storyId}/worldbook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as { entry?: WorldbookEntry; error?: string };
  if (!data.entry) throw new Error(data.error ?? "failed to create worldbook entry");
  return data.entry;
}

export async function updateWorldbookEntry(
  storyId: string,
  pageId: string,
  input: { content?: string; hidden?: boolean }
): Promise<void> {
  const res = await apiFetch(`/api/stories/${storyId}/worldbook/${pageId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!data.ok) throw new Error(data.error ?? "failed to update worldbook entry");
}

export type JobStreamEvent =
  | { type: "token"; text: string }
  | { type: "progress"; label: string }
  | { type: "sync"; text: string; progress?: string }
  | { type: "done"; fullText: string; followUp?: { jobId: string; pageId: string } }
  | { type: "error"; message: string }
  | { type: "cancelled" };

export async function cancelJob(storyId: string, jobId: string): Promise<void> {
  const res = await apiFetch(`/api/stories/${storyId}/jobs/${jobId}/cancel`, { method: "POST" });
  const data = await res.json();
  if (!res.ok && data.error) throw new Error(data.error);
}

export interface ActiveJob {
  id: string;
  createdAt: string;
  targetTextId: string | null;
  jobType: string;
  status: string;
  startedAt: string | null;
}

/** In-flight jobs for a story — used to reattach to a generation still running after the story tab was closed and reopened. */
export async function fetchActiveJobs(storyId: string): Promise<ActiveJob[]> {
  const res = await apiFetch(`/api/stories/${storyId}/jobs/active`);
  const data = (await res.json()) as { jobs: ActiveJob[] };
  return data.jobs;
}

/**
 * The stream route sends a periodic SSE comment as a heartbeat (see src/routes/stories.ts) so an
 * idle-socket timeout during a long, mostly-silent generation is unlikely — but if the
 * connection still drops before the final "done"/"error" message arrives, EventSource's
 * onerror gives no detail at all. Rather than leave the caller stuck forever (the "pending
 * reply never locks in" bug), reconcile against the job's own persisted status and either
 * reconnect (still in flight) or synthesize the terminal event (already resolved).
 */
export function streamJob(
  storyId: string,
  jobId: string,
  onEvent: (event: JobStreamEvent) => void
): () => void {
  let closed = false;
  let source: EventSource;

  async function reconcile() {
    if (closed) return;
    try {
      const res = await apiFetch(`/api/stories/${storyId}/jobs/${jobId}`);
      const data = (await res.json()) as { job?: { status: string; error: string | null }; error?: string };
      if (closed) return;
      if (!res.ok || !data.job) {
        onEvent({ type: "error", message: data.error ?? "job not found" });
        return;
      }
      if (data.job.status === "pending" || data.job.status === "running") {
        connect();
        return;
      }
      if (data.job.status === "done") {
        onEvent({ type: "done", fullText: "" });
      } else if (data.job.status === "cancelled") {
        onEvent({ type: "cancelled" });
      } else {
        onEvent({ type: "error", message: data.job.error ?? "job failed" });
      }
    } catch (err) {
      if (!closed) onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function connect() {
    // EventSource can't set custom headers, so the session id rides as a query param instead —
    // the guard checks both (see src/middleware/session-guard.ts).
    const sessionId = getSessionId();
    const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
    source = new EventSource(`${API_BASE}/api/stories/${storyId}/jobs/${jobId}/stream${query}`);
    source.onmessage = (message) => {
      if (message.data === "[DONE]") {
        source.close();
        return;
      }
      onEvent(JSON.parse(message.data) as JobStreamEvent);
    };
    source.onerror = () => {
      source.close();
      void reconcile();
    };
  }

  connect();
  return () => {
    closed = true;
    source.close();
  };
}
