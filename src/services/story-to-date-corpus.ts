/**
 * Story-to-date corpus helpers — shared by experiment CLI and production pipeline.
 */
import type Database from "better-sqlite3";
import { listChronologicalPages, type PageRow } from "../db/page-store.js";
import { getText, type TextRole, type TextRow } from "../db/text-store.js";
import { getBookByType } from "../db/book-store.js";
import { listWorldbookEntries, type WorldbookEntry } from "../db/worldbook-store.js";
import { resolveIcStartPageId } from "./kickoff.js";
import { AUTHOR_SYSTEM_PROMPT } from "../prompts.js";
import type { ChatMessage } from "../inference/featherless.js";
import {
  buildChainPostIndex,
  countChainPosts,
  resolveChainPostNumber,
  resolvePageIdForChainPost,
  resolvePageOrderForChainPost,
  resolveIcStartOrder,
} from "./post-index.js";

export const CHARS_PER_TOKEN_ESTIMATE = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/** Minimum IC posts kept verbatim in Author prompt even when archives cover them. */
export const MIN_VERBOSE_IC_POSTS = 16;

export {
  buildChainPostIndex,
  countChainPosts,
  resolveChainPostNumber,
  resolvePageIdForChainPost,
  resolvePageOrderForChainPost,
  resolveIcStartOrder,
  type ChainPostEntry,
} from "./post-index.js";

/** @deprecated Use countChainPosts */
export const countIcPosts = countChainPosts;
/** @deprecated Use resolveChainPostNumber */
export { resolveIcPostNumber, resolvePageIdForIcPost, resolvePageOrderForIcPost } from "./post-index.js";

function formatWorldbookEntry(entry: WorldbookEntry): string {
  return `[${entry.entryType.toUpperCase()}]\n${entry.content}`;
}

function toChatRole(role: TextRole): "user" | "assistant" | "system" {
  if (role === "agent") return "assistant";
  if (role === "system") return "system";
  return "user";
}

export interface VerbosePost {
  /** Absolute chain post number from kickoff (includes hidden turns). */
  icPostNumber: number;
  pageId: string;
  role: "user" | "assistant" | "system";
  content: string;
  tokens: number;
  hidden: boolean;
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
  /** First visible IC page — post numbering anchor. */
  icStartPageId: string;
  /** @deprecated Use icStartPageId */
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

  const chain = buildChainPostIndex(db, logbookId);
  let maxPostNumber = chain.length ? chain[chain.length - 1]!.postNumber : 0;
  if (options.fromPageId) {
    const fromPost = resolveChainPostNumber(db, logbookId, options.fromPageId);
    if (fromPost != null) maxPostNumber = fromPost;
  }

  const icStartPageId = resolveIcStartPageId(db, logbookId);
  if (!icStartPageId) {
    throw new Error("story has no visible IC posts — STORY BEGINS requires in-character log");
  }

  const worldbookLines: string[] = [];
  const worldbookBook = getBookByType(db, "worldbook");
  if (worldbookBook) {
    for (const entry of listWorldbookEntries(db, worldbookBook.id, { includeHidden: false })) {
      worldbookLines.push(formatWorldbookEntry(entry));
    }
  }
  const worldbookTokens = worldbookLines.reduce((sum, l) => sum + estimateTokens(l), 0);

  let afterPostNumber = 0;
  if (options.afterPageId) {
    afterPostNumber = resolveChainPostNumber(db, logbookId, options.afterPageId) ?? 0;
  }

  const posts: VerbosePost[] = [];
  for (const entry of buildChainPostIndex(db, logbookId)) {
    if (entry.postNumber > maxPostNumber) break;
    if (entry.postNumber <= afterPostNumber) continue;
    if (entry.hidden) continue;
    posts.push({
      icPostNumber: entry.postNumber,
      pageId: entry.pageId,
      role: toChatRole(entry.role),
      content: entry.content,
      tokens: estimateTokens(entry.content),
      hidden: false,
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
    icStartPageId,
    kickoffPageId: icStartPageId,
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
  parts.push("=== LOG (in-character verbose prose; post numbers are absolute from kickoff — hidden OOC turns occupy numbers but are omitted) ===");
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

// ── Feature A: bounded memory via recursive folding ──────────────────────────
/** Total assembled STORY TO DATE tokens above which the oldest segments get folded into a digest. */
export const STORY_TO_DATE_SOFT_CAP_TOKENS = 6000;
/** Newest segments (by cumulative token budget) kept detailed; everything older is eligible to fold. */
export const FOLD_KEEP_RECENT_TOKENS = 3000;
/** Fold output aims for this fraction of the folded input's word count (the model routinely beats it). */
export const FOLD_TARGET_RATIO = 0.5;

export interface FoldableSegment {
  id: string;
  content: string;
  coverageThroughIcPost: number | null;
  coveragePageId: string | null;
  seq: number;
}

/**
 * Deterministic split used by BOTH the fold trigger and the fold worker so they always agree on
 * which segments get folded. Always keeps the newest segment, then peels back more newest segments
 * until their cumulative tokens would exceed FOLD_KEEP_RECENT_TOKENS; everything older is the fold
 * set. Segments must be passed in seq-ascending (oldest-first) order.
 */
export function selectFoldSet(segments: FoldableSegment[]): { fold: FoldableSegment[]; keep: FoldableSegment[] } {
  if (segments.length <= 1) return { fold: [], keep: segments };
  let keepFromIdx = segments.length - 1; // newest is always kept detailed
  let keptTokens = estimateTokens(segments[keepFromIdx]!.content);
  for (let i = segments.length - 2; i >= 0; i--) {
    const t = estimateTokens(segments[i]!.content);
    if (keptTokens + t > FOLD_KEEP_RECENT_TOKENS) break;
    keptTokens += t;
    keepFromIdx = i;
  }
  return { fold: segments.slice(0, keepFromIdx), keep: segments.slice(keepFromIdx) };
}

/** Editor prompt for recursively compressing the older half of STORY TO DATE into a "deep past" digest. */
export function buildFoldSystem(targetWords: number): string {
  return `You are the Editor, condensing the older portion of a long story's memory into a compact "deep past" digest. The recent memory is kept separately in full — your job is only the older material provided here.

The text you receive is ALREADY a compressed, chronological memory of events. Compress it further: this is the distant past, where fine detail no longer matters, but the through-line must survive intact.

KEEP at full weight: unresolved threads; open promises, debts, and plans; secrets not yet revealed; standing relationships and their current state; deaths and permanent changes; injuries or conditions still in effect; anything a future scene or character could still reference or contradict.

COMPRESS hard or drop entirely: resolved sub-threads (a conflict that ended, a task that got done); one-off events with no lasting consequence; scene-level color and staging; anything already fully paid off. A resolved beat shrinks to a clause; an unresolved one keeps its shape.

Preserve chronology and the causal throughline (this led to that). Use proper names; never "you/your" for the player character. Do not invent events. Do not reference or fold in the recent memory — it is not here.

Length: aim for about ${targetWords} words — the load-bearing spine of the deep past, no more. Write flowing third-person prose in the same Register as the input — not clinical reportage.

Output ONLY the digest prose — no headings, labels, or commentary.`;
}

export function buildSeamCeilingInstruction(inputCeilingPost: number | null): string {
  if (inputCeilingPost == null) {
    return "End coverage at the last complete scene transition in the supplied log.";
  }
  return `The supplied log is complete through post ${inputCeilingPost} — in production, no posts beyond this existed yet. Treat post ${inputCeilingPost} as a hard ceiling: never summarize beyond post ${inputCeilingPost}. End on a natural scene seam at or before post ${inputCeilingPost}. If post ${inputCeilingPost} lands mid-scene or mid-conversation (embedded text threads *Name: …* count as part of the scene), roll [COVERAGE] back to the previous complete seam. Do not write closing framing ("the night closes", "they parted", etc.) for beats that continue after your coverage.`;
}

/** Soft target / hard cap words per covered post, injected into the Editor prompt to fight transcription bloat on high-affect scenes. Production defaults; STD_TARGET_WPP / STD_MAX_WPP env vars override for tuning experiments only. */
export const TARGET_WORDS_PER_COVERED_POST = 6;
export const MAX_WORDS_PER_COVERED_POST = 10;

/** Proportional length budget for an Editor block, scaled to how many posts it covers. */
export function buildLengthTargetInstruction(coveredPosts: number | null): string {
  if (coveredPosts == null || coveredPosts <= 0) {
    return "Length: compress hard — a paragraph or two of load-bearing memory, not a retelling. Length is earned by consequence, not by drama.";
  }
  const targetWpp = Number(process.env.STD_TARGET_WPP) || TARGET_WORDS_PER_COVERED_POST;
  const maxWpp = Number(process.env.STD_MAX_WPP) || MAX_WORDS_PER_COVERED_POST;
  const target = Math.round(coveredPosts * targetWpp);
  const cap = Math.round(coveredPosts * maxWpp);
  return `Length: this block covers roughly ${coveredPosts} posts — aim for about ${target} words and do not exceed ${cap} words. A quiet stretch should come in well under target; length is earned by consequence, not by drama.`;
}

export const INCLUDE_EXCLUDE_GUIDANCE = `INCLUDE: state changes, decisions, and their consequences; relationships and how they shift; emotional shifts and the tenor between characters; forms of address, nicknames, and pet names as they develop (these are relationship state); promises and commitments; secrets revealed or still hidden; injuries, deaths, and standing threats; anything a later scene would contradict if it were forgotten. Preserve the causal throughline (this happened, therefore…).

EXCLUDE: verbatim or near-verbatim dialogue; logistics and coordination chatter (who texted whom, who fetched what); blow-by-blow physical or sexual choreography beyond what changes the situation; songs, links, and references unless plot-loadbearing; eyeball kicks without plot weight. Do not invent events absent from the log.

Telling-only memory: state changes and relationship shifts — no beat-by-beat staging. Compress hardest where telling-not-showing risk is highest — high-affect beats tempt beat-by-beat transcription. Never paste or lightly reword lines from the log; paraphrase everything in the memory register — keep the emotional truth and what changed between characters, drop the moment-to-moment staging. The closing paragraphs must be as compressed as the opening ones.`;

export function buildDefaultBeginsSystemPrompt(
  inputCeilingPost: number | null,
  opts: { guidance?: string } = {}
): string {
  const ceiling = buildSeamCeilingInstruction(inputCeilingPost);
  const length = buildLengthTargetInstruction(inputCeilingPost);
  const guidance = opts.guidance ?? INCLUDE_EXCLUDE_GUIDANCE;

  return `You are the Editor, compressing a long roleplay log into a durable "story so far" memory block.

You receive the complete worldbook (CONTENT, ROSTER, MEMORY) and in-character verbose prose. Post numbers are absolute from kickoff as post 1; hidden OOC/guide turns occupy numbers in the sequence but are not included in the log — expect gaps (e.g. post 198, then post 209).

Write a [STORY BEGINS] block: third-person, matching the CONTENT Register — not clinical reportage. This is memory, not narration: telling-only memory — record what future scenes and NPCs must remember, not how it played out beat by beat.

${guidance}

${length}

Use the PC's proper name; never "you/your" for the player character.

${ceiling}

After [STORY BEGINS], report how far coverage reached using [COVERAGE]N[/COVERAGE] where N is the kickoff post number (e.g. [COVERAGE]71[/COVERAGE]). N must be ≤ ${inputCeilingPost ?? "the highest post in the input"} and must land on a complete scene, not mid-scene.

You must write [STORY BEGINS]…[/STORY BEGINS] then [COVERAGE]N[/COVERAGE]. Use the exact closing tag [/STORY BEGINS] — not [STORY ENDS]. No other text is read.`;
}

export function buildDefaultContinuesSystemPrompt(
  inputCeilingPost: number | null,
  priorCoveragePost: number | null,
  opts: { guidance?: string } = {}
): string {
  const prior =
    priorCoveragePost != null
      ? `[STORY TO DATE] already covers through post ${priorCoveragePost}. Only summarize posts after ${priorCoveragePost}. Open where [STORY TO DATE] left off — do not skip intervening events.`
      : "";

  const ceiling = buildSeamCeilingInstruction(inputCeilingPost);
  const coveredPosts =
    inputCeilingPost != null && priorCoveragePost != null ? inputCeilingPost - priorCoveragePost : null;
  const length = buildLengthTargetInstruction(coveredPosts);
  const guidance = opts.guidance ?? INCLUDE_EXCLUDE_GUIDANCE;

  return `You are the Editor, extending an existing "story so far" memory block.

You receive the complete worldbook, the current [STORY TO DATE], and new in-character verbose prose that begins after prior coverage ended. Post numbers are absolute from kickoff; hidden turns occupy numbers but are omitted from the log.

${prior}

Write a [STORY CONTINUES] block that picks up where [STORY TO DATE] left off — same Register, third person. This is memory, not narration: telling-only memory — record what future scenes and NPCs must remember, not how it played out beat by beat. Do not re-introduce events already in [STORY TO DATE] — extend the causal spine only. Do not invent events. Append-only: do not contradict or rewrite prior memory.

${guidance}

${length}

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

Rewrite ${block} with [COVERAGE] rolled back to the previous complete scene seam strictly before post ${inputCeilingPost}. Never summarize beyond the new coverage. Compress throughout; do not paste source posts verbatim. Same Register, telling-only memory, and rules as before.`;
}

export function shouldRetrySeamGate(coverageThroughPost: number, inputCeilingPost: number | null): boolean {
  return inputCeilingPost != null && coverageThroughPost === inputCeilingPost;
}

/** Strip echoed bracket labels the model sometimes pastes into memory prose. */
export function sanitizeStoryBlockContent(text: string): string {
  return text
    .replace(/\s*\[\/STORY (?:BEGINS|CONTINUES)\]\s*/gi, " ")
    .replace(/\s*\[STORY (?:BEGINS|CONTINUES|TO DATE|ENDS)\]\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function storyBlockWordList(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** Fraction of block A's words also present in block B (case-insensitive). */
export function storyBlockWordOverlapRatio(a: string, b: string): number {
  const aw = storyBlockWordList(a);
  const setB = new Set(storyBlockWordList(b).map((w) => w.toLowerCase()));
  const shared = aw.filter((w) => setB.has(w.toLowerCase())).length;
  return aw.length ? shared / aw.length : 0;
}

/** Continues blocks at or above this overlap with the prior segment are rejected and retried. */
export const STORY_BLOCK_DUPLICATE_OVERLAP_THRESHOLD = 0.85;

const NEXT_SCENE_LENGTH_INSTRUCTION =
  "Length: one scene only — typically 80–200 words (one or two paragraphs). Do not scale length to how many posts remain in the input; quiet scenes stay short.";

const NEXT_SCENE_CONTINUES_ADDENDUM = `SCOPE: Summarize only the next scene — the first self-contained beat after prior coverage ends. Do not batch multiple scenes. Do not re-state the closing beat already in [STORY TO DATE]; open on the first new consequential state change. Never echo bracket labels like [STORY CONTINUES] inside the prose.`;

function buildNextSceneCeilingInstruction(inputCeilingPost: number | null): string {
  if (inputCeilingPost == null) {
    return "End coverage at the first complete scene seam in the new log — not at the end of the input.";
  }
  return `The input includes posts through ${inputCeilingPost}, but you must NOT try to cover them all. Stop at the FIRST complete scene seam after prior coverage — even if dozens of posts remain. Treat ${inputCeilingPost} as an upper bound only, not a target. If that seam lands mid-conversation (embedded text threads count as one scene), roll [COVERAGE] back further. Do not write closing framing for beats that continue after your coverage.`;
}

/** Continues prompt: one scene per block instead of compressing the full input batch. */
export function buildNextSceneContinuesSystemPrompt(
  inputCeilingPost: number | null,
  priorCoveragePost: number | null,
  opts: { guidance?: string } = {}
): string {
  const prior =
    priorCoveragePost != null
      ? `[STORY TO DATE] already covers through post ${priorCoveragePost}. Only summarize posts after ${priorCoveragePost}. Open where [STORY TO DATE] left off — do not skip intervening events.`
      : "";

  const guidance = opts.guidance ?? INCLUDE_EXCLUDE_GUIDANCE;

  return `You are the Editor, extending an existing "story so far" memory block.

You receive the complete worldbook, the current [STORY TO DATE], and new in-character verbose prose that begins after prior coverage ended. Post numbers are absolute from kickoff; hidden turns occupy numbers but are omitted from the log.

${prior}

Write a [STORY CONTINUES] block that picks up where [STORY TO DATE] left off — same Register, third person. This is memory, not narration: telling-only memory — record what future scenes and NPCs must remember, not how it played out beat by beat. Do not re-introduce events already in [STORY TO DATE] — extend the causal spine only. Do not invent events. Append-only: do not contradict or rewrite prior memory.

${NEXT_SCENE_CONTINUES_ADDENDUM}

${guidance}

${NEXT_SCENE_LENGTH_INSTRUCTION}

${buildNextSceneCeilingInstruction(inputCeilingPost)}

After [STORY CONTINUES], report coverage through [COVERAGE]N[/COVERAGE] where N is the kickoff post number through which this block reaches (absolute). N must be ≤ ${inputCeilingPost ?? "the highest post in the input"} and must land on a complete scene, not mid-scene.

You must write [STORY CONTINUES]…[/STORY CONTINUES] then [COVERAGE]N[/COVERAGE]. Use the exact closing tag [/STORY CONTINUES] — not [STORY ENDS]. No other text is read.`;
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
