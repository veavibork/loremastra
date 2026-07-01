const API_BASE = "http://localhost:4114";

export interface Story {
  id: string;
  name: string;
  parentStoryId: string | null;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LayoutTab {
  id: string;
  label: string;
}

export interface LayoutSection {
  id: string;
  label: string;
  tabs: LayoutTab[];
}

export interface LayoutConfigData {
  sections: LayoutSection[];
}

export interface LayoutConfigResponse {
  id: string | null;
  name: string;
  config: LayoutConfigData;
}

export async function fetchLayout(): Promise<LayoutConfigResponse> {
  const res = await fetch(`${API_BASE}/api/layout`);
  return res.json();
}

export async function updateLayout(config: LayoutConfigData): Promise<LayoutConfigResponse> {
  const res = await fetch(`${API_BASE}/api/layout`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
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
}

export async function fetchJobs(storyId: string): Promise<Job[]> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/jobs`);
  const data = (await res.json()) as { jobs: Job[] };
  return data.jobs;
}

export async function fetchSlots(): Promise<{ used: number; max: number }> {
  const res = await fetch(`${API_BASE}/api/debug/slots`);
  return res.json();
}

export interface PromptMessage {
  role: string;
  content: string;
}

export async function fetchPromptPreview(storyId: string): Promise<PromptMessage[]> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/prompt-preview`);
  const data = (await res.json()) as { messages: PromptMessage[] };
  return data.messages;
}

export type AgentRole = "author" | "worker" | "editor";

export interface AgentProfile {
  model: string;
  temperature: number;
  responseLimit: number;
  contextLimit: number;
  fallbackModels?: string[];
}

export async function fetchAgentProfiles(): Promise<Record<AgentRole, AgentProfile>> {
  const res = await fetch(`${API_BASE}/api/agents`);
  const data = (await res.json()) as { profiles: Record<AgentRole, AgentProfile> };
  return data.profiles;
}

export async function updateAgentProfile(role: AgentRole, patch: Partial<AgentProfile>): Promise<AgentProfile> {
  const res = await fetch(`${API_BASE}/api/agents/${role}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = (await res.json()) as { profile: AgentProfile };
  return data.profile;
}

export async function renameStory(storyId: string, name: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}`, {
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
}

export type StoryPhase = "setup" | "kickoff" | "story";

export interface StoryState {
  phase: StoryPhase;
  kickoffPageId: string | null;
  currentPageId: string | null;
}

export async function fetchPhase(storyId: string): Promise<StoryState> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/phase`);
  return res.json();
}

export async function postSetupMessage(
  storyId: string,
  content: string
): Promise<{ jobId: string; agentPageId: string }> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/setup/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function startKickoff(storyId: string): Promise<{ jobId: string; kickoffPageId: string }> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/kickoff/start`, { method: "POST" });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function retryKickoff(
  storyId: string,
  guidance?: string
): Promise<{ jobId: string; kickoffPageId: string }> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/kickoff/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guidance }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function approveKickoff(storyId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/kickoff/approve`, { method: "POST" });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
}

export async function backToSetup(storyId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/kickoff/back`, { method: "POST" });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
}

export async function listStories(): Promise<Story[]> {
  const res = await fetch(`${API_BASE}/api/stories`);
  const data = (await res.json()) as { stories: Story[] };
  return data.stories;
}

export async function createStory(name: string): Promise<Story> {
  const res = await fetch(`${API_BASE}/api/stories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = (await res.json()) as { story: Story };
  return data.story;
}

export async function fetchLog(storyId: string): Promise<LogEntry[]> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/log`);
  const data = (await res.json()) as { entries: LogEntry[] };
  return data.entries;
}

export async function postMessage(
  storyId: string,
  content: string
): Promise<{ jobId: string; agentPageId: string }> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return res.json();
}

export async function retryPost(
  storyId: string,
  pageId: string,
  guidance?: string
): Promise<{ jobId: string; textId: string }> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/posts/${pageId}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guidance }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function editPost(storyId: string, pageId: string, content: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/posts/${pageId}/edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
}

export async function continuePost(
  storyId: string,
  guidance?: string
): Promise<{ agentPageId: string; jobId: string }> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guidance }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export interface Position {
  currentPageId: string | null;
  headPageId: string | null;
  atHead: boolean;
}

export async function fetchPosition(storyId: string): Promise<Position> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/position`);
  return res.json();
}

export async function undoPosition(storyId: string): Promise<Position> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/position/undo`, { method: "POST" });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function redoPosition(storyId: string): Promise<Position> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/position/redo`, { method: "POST" });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function jumpToPosition(storyId: string, pageId: string): Promise<Position> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/position`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pageId }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function forkStory(storyId: string, pageId?: string, name?: string): Promise<Story> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pageId, name }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.story;
}

export type WorldbookEntryType = "setting" | "register" | "location" | "creature" | "faction" | "character";

export interface WorldbookFieldSchema {
  key: string;
  label: string;
}

export interface WorldbookEntry {
  pageId: string;
  bookId: string;
  entryType: WorldbookEntryType;
  isPc: boolean;
  name: string;
  hidden: boolean;
  broken: boolean;
  createdAt: string;
  fields: Record<string, string>;
  currentTextId: string;
}

export interface Tag {
  id: string;
  bookId: string;
  name: string;
  worldbookPageId: string | null;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function fetchWorldbookSchemas(): Promise<Record<WorldbookEntryType, WorldbookFieldSchema[]>> {
  const res = await fetch(`${API_BASE}/api/worldbook-schemas`);
  const data = (await res.json()) as { schemas: Record<WorldbookEntryType, WorldbookFieldSchema[]> };
  return data.schemas;
}

export async function fetchWorldbook(storyId: string): Promise<WorldbookEntry[]> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/worldbook`);
  const data = (await res.json()) as { entries: WorldbookEntry[] };
  return data.entries;
}

export async function createWorldbookEntry(
  storyId: string,
  input: { entryType: WorldbookEntryType; isPc?: boolean; name: string; fields: Record<string, string> }
): Promise<WorldbookEntry> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/worldbook`, {
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
  input: { name?: string; fields?: Record<string, string>; hidden?: boolean }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/worldbook/${pageId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!data.ok) throw new Error(data.error ?? "failed to update worldbook entry");
}

export async function fetchTags(storyId: string): Promise<Tag[]> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/tags`);
  const data = (await res.json()) as { tags: Tag[] };
  return data.tags;
}

export async function createTag(storyId: string, name: string, worldbookPageId?: string | null): Promise<Tag> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, worldbookPageId: worldbookPageId ?? null }),
  });
  const data = (await res.json()) as { tag?: Tag; error?: string };
  if (!data.tag) throw new Error(data.error ?? "failed to create tag");
  return data.tag;
}

export async function updateTag(
  storyId: string,
  tagId: string,
  input: { name?: string; hidden?: boolean; worldbookPageId?: string | null }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/stories/${storyId}/tags/${tagId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!data.ok) throw new Error(data.error ?? "failed to update tag");
}

export type JobStreamEvent =
  | { type: "token"; text: string }
  | { type: "done"; fullText: string }
  | { type: "error"; message: string };

export function streamJob(
  storyId: string,
  jobId: string,
  onEvent: (event: JobStreamEvent) => void
): () => void {
  const source = new EventSource(`${API_BASE}/api/stories/${storyId}/jobs/${jobId}/stream`);
  source.onmessage = (message) => {
    if (message.data === "[DONE]") {
      source.close();
      return;
    }
    onEvent(JSON.parse(message.data) as JobStreamEvent);
  };
  source.onerror = () => {
    source.close();
  };
  return () => source.close();
}
