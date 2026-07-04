/**
 * Story-to-date corpus helpers — shared by experiment CLI and production pipeline.
 */
import type Database from "better-sqlite3";
import { listChronologicalPages, type PageRow } from "../db/page-store.js";
import { getText, type TextRole, type TextRow } from "../db/text-store.js";
import { getBookByType } from "../db/book-store.js";
import { listWorldbookEntries, type WorldbookEntry } from "../db/worldbook-store.js";
import { getStoryState } from "../db/story-state-store.js";
import { AUTHOR_SYSTEM_PROMPT } from "../prompts.js";
import type { ChatMessage } from "../inference/featherless.js";

export const CHARS_PER_TOKEN_ESTIMATE = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/** Minimum IC posts kept verbatim in Author prompt even when archives cover them. */
export const MIN_VERBOSE_IC_POSTS = 16;

/** Count in-character posts (from kickoff) with content on the active log chain. */
export function countIcPosts(db: Database.Database, logbookId: string, includeHidden = false): number {
  const pages = listChronologicalPages(db, logbookId).filter((p) => includeHidden || !p.hidden);
  const kickoffPageId = getStoryState(db).kickoffPageId;
  if (!kickoffPageId) return 0;
  const kickoffOrder = pages.findIndex((p) => p.id === kickoffPageId);
  if (kickoffOrder < 0) return 0;
  let n = 0;
  for (let order = kickoffOrder; order < pages.length; order++) {
    const page = pages[order]!;
    if (!page.selectedTextId) continue;
    const text = getText(db, page.selectedTextId);
    if (!text?.genPackage?.trim()) continue;
    n++;
  }
  return n;
}

/** 1-based IC post number for a page on the active chain, or null if before kickoff / no content. */
export function resolveIcPostNumber(db: Database.Database, logbookId: string, pageId: string): number | null {
  const pages = listChronologicalPages(db, logbookId);
  const kickoffPageId = getStoryState(db).kickoffPageId;
  if (!kickoffPageId) return null;
  const kickoffOrder = pages.findIndex((p) => p.id === kickoffPageId);
  if (kickoffOrder < 0) return null;
  let ic = 0;
  for (let order = 0; order < pages.length; order++) {
    if (order < kickoffOrder) continue;
    const page = pages[order]!;
    if (!page.selectedTextId) continue;
    const text = getText(db, page.selectedTextId);
    if (!text?.genPackage?.trim()) continue;
    ic++;
    if (page.id === pageId) return ic;
  }
  return null;
}

/** Page list index (historyPages order) of the last IC post at or before `icPostNumber`. */
export function resolvePageOrderForIcPost(
  pages: PageRow[],
  kickoffOrder: number,
  db: Database.Database,
  icPostNumber: number
): number {
  if (icPostNumber <= 0) return kickoffOrder - 1;
  let ic = 0;
  for (let order = 0; order < pages.length; order++) {
    if (order < kickoffOrder) continue;
    const page = pages[order]!;
    if (!page.selectedTextId) continue;
    const text = getText(db, page.selectedTextId);
    if (!text?.genPackage?.trim()) continue;
    ic++;
    if (ic >= icPostNumber) return order;
  }
  return pages.length - 1;
}

export function resolvePageIdForIcPost(
  db: Database.Database,
  logbookId: string,
  icPostNumber: number
): string | null {
  const pages = listChronologicalPages(db, logbookId);
  const kickoffPageId = getStoryState(db).kickoffPageId;
  if (!kickoffPageId) return null;
  const kickoffOrder = pages.findIndex((p) => p.id === kickoffPageId);
  if (kickoffOrder < 0) return null;
  const order = resolvePageOrderForIcPost(pages, kickoffOrder, db, icPostNumber);
  return pages[order]?.id ?? null;
}

function formatWorldbookEntry(entry: WorldbookEntry): string {
  return `[${entry.entryType.toUpperCase()}]\n${entry.content}`;
}

function toChatRole(role: TextRole): "user" | "assistant" | "system" {
  if (role === "agent") return "assistant";
  if (role === "system") return "system";
  return "user";
}

export interface VerbosePost {
  /** 1-based in-character post number from kickoff onward. */
  icPostNumber: number;
  pageId: string;
  role: "user" | "assistant" | "system";
  content: string;
  tokens: number;
}

export interface StoryCorpus {
  storyId: string;
  logbookId: string;
  contextLimit: number;
  responseLimit: number;
  usableBudget: number;
  systemTokens: number;
  worldbookLines: string[];
  worldbookTokens: number;
  posts: VerbosePost[];
  historyTokens: number;
  /** Full Author-style prompt if every post were verbose (no archives). */
  fullPromptTokens: number;
  /** Posts included when truncating to inputCutoff fraction of usable budget. */
  includedPosts: VerbosePost[];
  includedHistoryTokens: number;
  includedPromptTokens: number;
  /** Highest icPostNumber supplied in this Editor input (token ceiling). */
  inputCeilingPost: number | null;
  inputCeilingPageId: string | null;
  kickoffPageId: string;
}

export interface CorpusOptions {
  contextLimit: number;
  responseLimit: number;
  /** Fraction of usable budget (0–1) for worldbook + verbose input to the Editor job. Default 0.8 = full log to trigger point. */
  inputCutoff?: number;
  fromPageId?: string | null;
  /** For STORY CONTINUES — only include posts strictly after this page id. */
  afterPageId?: string | null;
  /** Prior merged [STORY TO DATE] text — counts toward Editor input budget in continues mode. */
  priorStoryToDate?: string | null;
  /** Experiment override: include posts through this IC post number even if over token budget. */
  throughPost?: number | null;
}

/** Build worldbook + full verbose history stats and a truncated corpus for Editor input. */
export function buildStoryCorpus(
  db: Database.Database,
  storyId: string,
  logbookId: string,
  options: CorpusOptions
): StoryCorpus {
  const inputCutoff = options.inputCutoff ?? 0.8;
  const usableBudget = options.contextLimit - options.responseLimit;
  const systemTokens = estimateTokens(AUTHOR_SYSTEM_PROMPT);

  const pages = listChronologicalPages(db, logbookId).filter((p) => !p.hidden);
  const cutoffIdx = options.fromPageId ? pages.findIndex((p) => p.id === options.fromPageId) : pages.length - 1;
  const historyPages: PageRow[] = cutoffIdx >= 0 ? pages.slice(0, cutoffIdx + 1) : pages;

  const kickoffPageId = getStoryState(db).kickoffPageId;
  if (!kickoffPageId) {
    throw new Error("story has no kickoff page — STORY BEGINS requires in-character log");
  }
  const kickoffOrder = historyPages.findIndex((p) => p.id === kickoffPageId);
  if (kickoffOrder < 0) {
    throw new Error("kickoff page not found in visible log");
  }

  const worldbookLines: string[] = [];
  const worldbookBook = getBookByType(db, "worldbook");
  if (worldbookBook) {
    for (const entry of listWorldbookEntries(db, worldbookBook.id, { includeHidden: false })) {
      worldbookLines.push(formatWorldbookEntry(entry));
    }
  }
  const worldbookTokens = worldbookLines.reduce((sum, l) => sum + estimateTokens(l), 0);

  const posts: VerbosePost[] = [];
  let afterOrder = kickoffOrder - 1;
  if (options.afterPageId) {
    const idx = historyPages.findIndex((p) => p.id === options.afterPageId);
    if (idx >= 0) afterOrder = idx;
  }

  let icPostNumber = 0;
  for (let order = 0; order < historyPages.length; order++) {
    const page = historyPages[order]!;
    if (order < kickoffOrder) continue;
    if (!page.selectedTextId) continue;
    const text = getText(db, page.selectedTextId);
    if (!text?.genPackage?.trim()) continue;
    icPostNumber++;
    if (order <= afterOrder) continue;
    const content = text.genPackage.trim();
    posts.push({
      icPostNumber,
      pageId: page.id,
      role: toChatRole(text.role),
      content,
      tokens: estimateTokens(content),
    });
  }

  const historyTokens = posts.reduce((sum, p) => sum + p.tokens, 0);
  const fullPromptTokens = systemTokens + worldbookTokens + historyTokens;

  const inputBudget = Math.floor(usableBudget * inputCutoff);
  let spent = worldbookTokens;
  const priorStoryTokens = options.priorStoryToDate?.trim()
    ? estimateTokens(options.priorStoryToDate)
    : 0;
  spent += priorStoryTokens;

  const includedPosts: VerbosePost[] = [];
  let inputCeilingPost: number | null = null;
  let inputCeilingPageId: string | null = null;

  if (options.throughPost != null && options.throughPost > 0) {
    for (const post of posts) {
      if (post.icPostNumber > options.throughPost) break;
      includedPosts.push(post);
      inputCeilingPost = post.icPostNumber;
      inputCeilingPageId = post.pageId;
    }
  } else {
    for (const post of posts) {
      if (spent + post.tokens > inputBudget) break;
      includedPosts.push(post);
      spent += post.tokens;
      inputCeilingPost = post.icPostNumber;
      inputCeilingPageId = post.pageId;
    }
  }

  const includedHistoryTokens = includedPosts.reduce((sum, p) => sum + p.tokens, 0);

  return {
    storyId,
    logbookId,
    contextLimit: options.contextLimit,
    responseLimit: options.responseLimit,
    usableBudget,
    systemTokens,
    worldbookLines,
    worldbookTokens,
    posts,
    historyTokens,
    fullPromptTokens,
    includedPosts,
    includedHistoryTokens,
    includedPromptTokens: worldbookTokens + priorStoryTokens + includedHistoryTokens,
    inputCeilingPost,
    inputCeilingPageId,
    kickoffPageId,
  };
}

export function wouldTriggerStoryToDate(corpus: StoryCorpus, triggerThreshold = 0.8): boolean {
  return corpus.fullPromptTokens >= corpus.usableBudget * triggerThreshold;
}

export function formatCorpusForEditor(
  corpus: StoryCorpus,
  posts = corpus.includedPosts,
  includeWorldbook = true
): string {
  const parts: string[] = [];
  if (includeWorldbook && corpus.worldbookLines.length) {
    parts.push("=== WORLDBOOK ===\n" + corpus.worldbookLines.join("\n\n"));
  }
  parts.push("=== LOG (in-character verbose prose, numbered from kickoff as post 1) ===");
  for (const post of posts) {
    parts.push(`--- post ${post.icPostNumber} (${post.role}) ---\n${post.content}`);
  }
  return parts.join("\n\n");
}

export type StoryBlockKind = "begins" | "continues";

const BLOCK_CLOSING: Record<StoryBlockKind, RegExp> = {
  begins: /\[\/STORY BEGINS\]|\[STORY ENDS\]/i,
  continues: /\[\/STORY CONTINUES\]|\[STORY ENDS\]/i,
};

export function extractStoryBlock(text: string, kind: StoryBlockKind): string | null {
  const trimmed = text.trim();
  const open = kind === "begins" ? /\[STORY BEGINS\]/i : /\[STORY CONTINUES\]/i;
  const openMatch = open.exec(trimmed);
  if (!openMatch) return null;
  const start = openMatch.index + openMatch[0].length;
  const rest = trimmed.slice(start);
  const closeMatch = BLOCK_CLOSING[kind].exec(rest);
  const coverageMatch = /\[COVERAGE\]\d+\[\/COVERAGE\]/i.exec(rest);
  let end = rest.length;
  if (closeMatch && closeMatch.index >= 0) end = Math.min(end, closeMatch.index);
  if (coverageMatch && coverageMatch.index >= 0) end = Math.min(end, coverageMatch.index);
  const body = rest.slice(0, end).trim();
  return body || null;
}

export function extractCoverage(text: string): number | null {
  const match = /\[COVERAGE\](\d+)\[\/COVERAGE\]/i.exec(text.trim());
  if (!match?.[1]) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface StoryToDateSegment {
  kind: StoryBlockKind;
  content: string;
  coverageThroughPost: number;
  coveragePageId: string | null;
}

/** Merge [STORY BEGINS] + [STORY CONTINUES]* into one [STORY TO DATE] block for Author prompt. */
export function mergeStoryToDate(segments: StoryToDateSegment[]): string {
  if (!segments.length) return "";
  const body = segments.map((s) => s.content.trim()).filter(Boolean).join("\n\n");
  return `[STORY TO DATE]\n${body}\n[/STORY TO DATE]`;
}

export function buildSeamCeilingInstruction(inputCeilingPost: number | null): string {
  if (inputCeilingPost == null) {
    return "End coverage at the last complete scene transition in the supplied log.";
  }
  return `The supplied log is complete through post ${inputCeilingPost} — in production, no posts beyond this existed yet. Treat post ${inputCeilingPost} as a hard ceiling: never summarize beyond post ${inputCeilingPost}. End on a natural scene seam at or before post ${inputCeilingPost}. If post ${inputCeilingPost} lands mid-scene or mid-conversation (embedded text threads *Name: …* count as part of the scene), roll [COVERAGE] back to the previous complete seam. Do not write closing framing ("the night closes", "they parted", etc.) for beats that continue after your coverage.`;
}

export function buildDefaultBeginsSystemPrompt(inputCeilingPost: number | null): string {
  const ceiling = buildSeamCeilingInstruction(inputCeilingPost);

  return `You are the Editor, compressing a long roleplay log into a durable "story so far" memory block.

You receive the complete worldbook (CONTENT, ROSTER, MEMORY) and in-character verbose prose numbered from the kickoff post as post 1.

Write a [STORY BEGINS] block: third-person, matching the CONTENT register and tonality — not a neutral recap. Cover loadbearing events, relationships, promises, secrets revealed, and state changes that future scenes and NPCs must remember and build on. Preserve causal throughline (this happened, therefore…). Do not invent events absent from the log.

Compress throughout — never paste lines from the verbose log. Paraphrase dialogue in the memory register; the closing paragraphs must be as compressed as the opening ones.

Use the PC's proper name; never "you/your" for the player character.

${ceiling}

After [STORY BEGINS], report how far coverage reached using [COVERAGE]N[/COVERAGE] where N is the kickoff post number (e.g. [COVERAGE]71[/COVERAGE]). N must be ≤ ${inputCeilingPost ?? "the highest post in the input"} and must land on a complete scene, not mid-scene.

You must write [STORY BEGINS]…[/STORY BEGINS] then [COVERAGE]N[/COVERAGE]. Use the exact closing tag [/STORY BEGINS] — not [STORY ENDS]. No other text is read.`;
}

export function buildDefaultContinuesSystemPrompt(
  inputCeilingPost: number | null,
  priorCoveragePost: number | null
): string {
  const prior =
    priorCoveragePost != null
      ? `[STORY TO DATE] already covers through post ${priorCoveragePost}. Only summarize posts after ${priorCoveragePost}. Open where [STORY TO DATE] left off — do not skip intervening events.`
      : "";

  const ceiling = buildSeamCeilingInstruction(inputCeilingPost);

  return `You are the Editor, extending an existing "story so far" memory block.

You receive the complete worldbook, the current [STORY TO DATE], and new in-character verbose prose (numbered from kickoff as post 1) that begins after prior coverage ended.

${prior}

Write a [STORY CONTINUES] block that picks up where [STORY TO DATE] left off — same register, third person, loadbearing facts only. Do not repeat [STORY TO DATE]. Do not invent events. Append-only: do not contradict or rewrite prior memory.

Compress throughout — never paste lines from the verbose log. Paraphrase dialogue in the memory register; the closing paragraphs must be as compressed as the opening ones. Do not dump final posts verbatim when the input runs long.

${ceiling}

After [STORY CONTINUES], report coverage through [COVERAGE]N[/COVERAGE] where N is the kickoff post number through which this block reaches (absolute). N must be ≤ ${inputCeilingPost ?? "the highest post in the input"} and must land on a complete scene, not mid-scene.

You must write [STORY CONTINUES]…[/STORY CONTINUES] then [COVERAGE]N[/COVERAGE]. Use the exact closing tag [/STORY CONTINUES] — not [STORY ENDS]. No other text is read.`;
}

export function buildSeamRetryUserMessage(
  mode: StoryBlockKind,
  coverageThroughPost: number,
  inputCeilingPost: number
): string {
  const block = mode === "begins" ? "[STORY BEGINS]" : "[STORY CONTINUES]";
  return `Your [COVERAGE]${coverageThroughPost} equals the input ceiling (post ${inputCeilingPost}). That ceiling likely lands mid-scene or mid-conversation — embedded text threads count as one scene until the beat resolves.

Rewrite ${block} with [COVERAGE] rolled back to the previous complete scene seam strictly before post ${inputCeilingPost}. Never summarize beyond the new coverage. Compress throughout; do not paste source posts verbatim. Same register and rules as before.`;
}

export function shouldRetrySeamGate(coverageThroughPost: number, inputCeilingPost: number | null): boolean {
  return inputCeilingPost != null && coverageThroughPost === inputCeilingPost;
}

export function stripStoryToDateWrapper(text: string): string {
  const match = /\[STORY TO DATE\]([\s\S]*?)\[\/STORY TO DATE\]/i.exec(text.trim());
  return match?.[1]?.trim() ?? text.trim();
}

export function buildExperimentMessages(
  mode: StoryBlockKind,
  corpus: StoryCorpus,
  opts: {
    priorStoryToDate?: string;
    priorCoveragePost?: number | null;
    systemPromptOverride?: string;
    posts?: VerbosePost[];
    includeWorldbook?: boolean;
  }
): ChatMessage[] {
  const posts = opts.posts ?? corpus.includedPosts;
  const corpusText = formatCorpusForEditor(corpus, posts, true);
  const system =
    opts.systemPromptOverride?.trim() ||
    (mode === "begins"
      ? buildDefaultBeginsSystemPrompt(corpus.inputCeilingPost)
      : buildDefaultContinuesSystemPrompt(corpus.inputCeilingPost, opts.priorCoveragePost ?? null));

  const user =
    mode === "begins"
      ? `Compress the following into [STORY BEGINS]:\n\n${corpusText}`
      : `[STORY TO DATE]\n${stripStoryToDateWrapper(opts.priorStoryToDate?.trim() || "(empty)")}\n\nNew log prose to fold in:\n\n${corpusText}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
