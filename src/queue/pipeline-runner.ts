import type Database from "better-sqlite3";
import { claimNextJob, finishJob, type JobType } from "../db/job-store.js";
import { fillTextExtract, fillTextGeneration, getText } from "../db/text-store.js";
import { getPage, listChronologicalPages } from "../db/page-store.js";
import { getBookByType, getTagScopeBookId } from "../db/book-store.js";
import { listWorldbookEntries } from "../db/worldbook-store.js";
import { fillArchiveSummary, getArchive, listMemberTextIds } from "../db/archive-store.js";
import { getStoryState } from "../db/story-state-store.js";
import { tryAcquireSlots, releaseSlots } from "./slots.js";
import { publishToken, publishProgress, publishDone, publishError } from "./job-events.js";
import {
  streamInference,
  callWithForcedTool,
  withModelFallback,
  FeatherlessError,
  type ChatMessage,
  type ToolDefinition,
} from "../inference/featherless.js";
import type { AgentProfile } from "../config.js";
import { assembleAuthorPrompt, assembleKickoffPrompt } from "../services/history.js";
import { EDITOR_SETUP_SYSTEM_PROMPT, runWorldbookExtraction } from "../services/setup.js";
import { indexTextAgainstAllTags } from "../services/tag-index.js";
import { getAgentProfile } from "../services/agent-config.js";
import { matchesRefusalPrefix } from "../services/refusal-detection.js";

const SCAN_INTERVAL_MS = 500;
const CLAIMABLE_JOB_TYPES: JobType[] = ["prose", "compress", "archive", "setup"];

/**
 * Guided retry's direction text is explicitly not stored as a post
 * (loremaster.md: "The guidance itself is not stored as a post") — it's
 * job-scoped and ephemeral, threaded through in memory rather than the DB,
 * the same way job-events.ts already handles other non-persisted job state.
 */
const jobGuidance = new Map<string, string>();
export function setJobGuidance(jobId: string, guidance: string): void {
  jobGuidance.set(jobId, guidance);
}
const COMPRESS_MAX_ATTEMPTS = 3;
const COMPRESS_MAX_WORDS = 60; // generous ceiling — a real ~20-token summary is well under this; catches "ignored the prompt and kept writing" cases
const ARCHIVE_MAX_ATTEMPTS = 3;
const ARCHIVE_MAX_WORDS = 150; // generous ceiling for a ~60-token narrative summary

export const COMPRESS_SYSTEM_PROMPT =
  "You compress a single roleplay post into a short, dense, factual summary of about 20 tokens. " +
  "State only what happened. If you're given what happened just before this post, frame this post as " +
  "what changed or followed from that (but/therefore) rather than an isolated fact. Replace pronouns " +
  "(he/him/she/her/they/them) with the actual character name they refer to — use the character roster " +
  "and prior context you're given to figure out who's meant. The summary has to name who did what on " +
  "its own; other systems match character names against it later and can't resolve a pronoun back to a " +
  "post they never see. No commentary, no scene-setting, no dialogue quoting.";

export const ARCHIVE_SYSTEM_PROMPT =
  "You write a short narrative summary (about 60 tokens) of a block of roleplay posts, given as a " +
  "sequence of factual compressed lines. Weave them into a causal throughline — this happened, BUT this " +
  "complicated it, THEREFORE this followed — not a flat list of events. Preserve who did what to whom; " +
  "don't blur which character acted and which reacted. No commentary, no meta-text.";

export const SUMMARY_TOOL: ToolDefinition = {
  name: "submit_summary",
  description: "Submit the compressed factual summary of the post.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "A short, dense, factual summary of about 20 tokens. State only what happened. Use character " +
          "names, not pronouns.",
      },
    },
    required: ["summary"],
  },
};

export const ARCHIVE_TOOL: ToolDefinition = {
  name: "submit_archive_summary",
  description: "Submit the narrative summary of this block of posts.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "A flowing narrative summary of about 60 tokens covering the whole block.",
      },
    },
    required: ["summary"],
  },
};

function withinWordLimit(text: string, maxWords: number): boolean {
  return !!text && text.split(/\s+/).length <= maxWords;
}

/**
 * Streams a reply with model fallback, treating an empty-but-error-free completion as a
 * retriable failure rather than a valid (if useless) result. Providers sometimes signal
 * overload by closing the stream immediately with zero content chunks instead of a clean
 * HTTP error (observed live with Kimi-K2-Instruct returning a 503 on a plain non-streaming
 * call, moments after a streaming call to the same model produced zero tokens with no
 * error) — without this, that failure mode would silently bypass withModelFallback
 * entirely, since the emptiness was only ever checked after it had already returned.
 */
async function streamWithFallback(
  profile: AgentProfile,
  messages: ChatMessage[],
  jobId: string
): Promise<{ text: string; model: string }> {
  let reply = "";
  let usedModel = profile.model;
  await withModelFallback(profile, (candidate) => {
    reply = "";
    usedModel = candidate.model;
    return new Promise<void>((resolve, reject) => {
      void streamInference(candidate, messages, {
        onToken: (text) => {
          reply += text;
          publishToken(jobId, text);
        },
        onDone: () => {
          if (reply.trim()) resolve();
          else reject(new FeatherlessError(503, `${candidate.model} returned an empty completion`));
        },
        onError: reject,
      });
    });
  });
  return { text: reply, model: usedModel };
}

// Deliberately not gated by src/middleware/session-guard.ts — this loop isn't an HTTP
// request, and per the single-active-session design a job a since-superseded session
// started still runs to completion; claiming only changes who's allowed to submit *new*
// interactions, not what happens to work already in flight.
let timer: NodeJS.Timeout | null = null;
const trackedDbs = new Map<string, Database.Database>();

/** The pipeline runner only scans stories the API has actually touched this process lifetime — fine for a handful of users, one active story each. */
export function trackStoryDb(storyId: string, db: Database.Database): void {
  trackedDbs.set(storyId, db);
}

/** Must be called whenever a story's underlying DB handle is closed (e.g. story deletion) — otherwise the next scan tick hits a closed better-sqlite3 connection and throws inside a bare setInterval callback, which is fatal to the whole process (see stub-revisions.md, 2026-07-02). */
export function untrackStoryDb(storyId: string): void {
  trackedDbs.delete(storyId);
}

export function startPipelineRunner(): void {
  if (timer) return;
  timer = setInterval(scanOnce, SCAN_INTERVAL_MS);
}

export function stopPipelineRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function scanOnce(): void {
  for (const [storyId, db] of trackedDbs) {
    // Belt-and-suspenders on top of untrackStoryDb: a closed connection (or any other
    // per-story fault) must never take down the shared setInterval loop that every other
    // tracked story depends on. An uncaught throw here is fatal to the whole process — this
    // is exactly what happened before untrackStoryDb existed (see stub-revisions.md).
    try {
      scanStory(db);
    } catch (err) {
      if (!db.open) trackedDbs.delete(storyId);
      console.error(`pipeline scan failed for story ${storyId}:`, err instanceof Error ? err.message : err);
    }
  }
}

function scanStory(db: Database.Database): void {
    const job = claimNextJob(db, CLAIMABLE_JOB_TYPES);
    if (!job) return;
    if (!tryAcquireSlots(job.slotCost)) {
      // Claimed but no slot free right now — put it back rather than block the scan loop.
      db.prepare(`UPDATE jobs SET status = 'pending', started_at = NULL WHERE id = ?`).run(job.id);
      return;
    }
    if (job.jobType === "compress" && job.targetTextId) {
      void executeCompressJob(db, job.id, job.targetTextId, job.slotCost);
    } else if (job.jobType === "archive" && job.targetArchiveId) {
      void executeArchiveJob(db, job.id, job.targetArchiveId, job.slotCost);
    } else if (job.jobType === "prose" && job.targetTextId) {
      void executeProseJob(db, job.id, job.targetTextId, job.slotCost);
    } else if (job.jobType === "setup" && job.targetTextId) {
      void executeSetupJob(db, job.id, job.targetTextId, job.slotCost);
    } else {
      finishJob(db, job.id, "failed", `job ${job.id} (${job.jobType}) has no valid target`);
      releaseSlots(job.slotCost);
    }
}

async function executeProseJob(
  db: Database.Database,
  jobId: string,
  targetTextId: string,
  slotCost: number
): Promise<void> {
  const startedAt = Date.now();
  try {
    const targetText = getText(db, targetTextId);
    if (!targetText) throw new Error("target text no longer exists");
    const targetPage = getPage(db, targetText.pageId);
    if (!targetPage) throw new Error("target page no longer exists");

    // Kickoff's opening post (and any guided retry of it) is the only prose job that
    // runs during the 'kickoff' phase — see loremaster.md's Story Flow: the author
    // generates it from the worldbook alone, not the setup conversation's chat log.
    const phase = getStoryState(db).phase;
    let history: ChatMessage[];
    if (phase === "kickoff") {
      const worldbook = getBookByType(db, "worldbook");
      if (!worldbook) throw new Error("worldbook not found");
      history = assembleKickoffPrompt(db, worldbook.id);
    } else {
      history = assembleAuthorPrompt(db, targetPage.bookId, targetPage.prevPageId);
    }

    const guidance = jobGuidance.get(jobId);
    if (guidance) {
      jobGuidance.delete(jobId);
      history = [...history, { role: "system", content: `Guidance for this generation: ${guidance}` }];
    }

    const { text: fullText, model } = await streamWithFallback(getAgentProfile("author"), history, jobId);

    // chars/4 is the same rough estimate used for prompt budgeting elsewhere (see history.ts) —
    // not a real tokenizer, good enough for the Logs telemetry view's ballpark numbers.
    const tokenEstimate = Math.ceil(fullText.length / 4);
    const metrics = { elapsedMs: Date.now() - startedAt, tokenEstimate };
    fillTextGeneration(db, targetTextId, { genPackage: fullText, genMetrics: JSON.stringify(metrics) });
    indexTextAgainstAllTags(db, getTagScopeBookId(db, targetPage.bookId), targetTextId);
    finishJob(db, jobId, "done", undefined, { model, tokenEstimate });
    publishDone(jobId, fullText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishJob(db, jobId, "failed", message);
    publishError(jobId, message);
  } finally {
    releaseSlots(slotCost);
  }
}

/** Every prior turn in the setup conversation, verbatim (no tiering — these conversations are short-lived), up to and including the given page. */
function buildSetupConversation(db: Database.Database, logbookId: string, uptoPageId: string | null): ChatMessage[] {
  const pages = listChronologicalPages(db, logbookId).filter((p) => !p.hidden);
  const cutoffIdx = uptoPageId ? pages.findIndex((p) => p.id === uptoPageId) : pages.length - 1;
  const historyPages = cutoffIdx >= 0 ? pages.slice(0, cutoffIdx + 1) : pages;

  const messages: ChatMessage[] = [];
  for (const page of historyPages) {
    if (!page.selectedTextId) continue;
    const text = getText(db, page.selectedTextId);
    if (!text?.genPackage) continue;
    messages.push({ role: text.role === "agent" ? "assistant" : "user", content: text.genPackage });
  }
  return messages;
}

/**
 * The Editor's setup turn — a volley, not one call: the Editor (DeepSeek, streamed like
 * prose) generates the conversational reply the user actually reads, then the Worker's
 * model reads the exchange and records any worldbook facts via one forced tool call.
 * Splitting it this way keeps DeepSeek's established creative/content-boundary voice for
 * the visible reply while routing structured extraction to the model already proven
 * reliable at forced tool-calling (compress/archive) — see docs/stub-revisions.md. If
 * extraction fails, the conversational reply still stands; a background-extraction
 * hiccup shouldn't erase what the user already sees.
 */
async function executeSetupJob(
  db: Database.Database,
  jobId: string,
  targetTextId: string,
  slotCost: number
): Promise<void> {
  try {
    const targetText = getText(db, targetTextId);
    if (!targetText) throw new Error("target text no longer exists");
    const targetPage = getPage(db, targetText.pageId);
    if (!targetPage) throw new Error("target page no longer exists");

    const worldbook = getBookByType(db, "worldbook");
    if (!worldbook) throw new Error("worldbook not found");

    let conversation = buildSetupConversation(db, targetPage.bookId, targetPage.prevPageId);
    const guidance = jobGuidance.get(jobId);
    if (guidance) {
      jobGuidance.delete(jobId);
      conversation = [...conversation, { role: "system", content: `Guidance for this reply: ${guidance}` }];
    }

    const editorMessages: ChatMessage[] = [{ role: "system", content: EDITOR_SETUP_SYSTEM_PROMPT }, ...conversation];
    const { text: reply, model } = await streamWithFallback(getAgentProfile("editor"), editorMessages, jobId);

    const tokenEstimate = Math.ceil(reply.length / 4);
    fillTextGeneration(db, targetTextId, { genPackage: reply, genMetrics: JSON.stringify({ tokenEstimate }) });

    publishProgress(jobId, "Updating worldbook...");
    try {
      await runWorldbookExtraction(db, worldbook.id, getTagScopeBookId(db, targetPage.bookId), [
        ...conversation,
        { role: "assistant", content: reply },
      ]);
    } catch (err) {
      console.error(`[setup ${jobId}] worldbook extraction failed, reply still stands:`, err);
    }

    finishJob(db, jobId, "done", undefined, { model, tokenEstimate });
    publishDone(jobId, reply);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishJob(db, jobId, "failed", message);
    publishError(jobId, message);
  } finally {
    releaseSlots(slotCost);
  }
}

/**
 * Simplification vs. the full doc spec: this only gives the Worker the
 * immediately preceding post's already-compressed line (via the immutable
 * prevPageId link, not the fork-aware selected-chain), so it can frame this
 * post causally (but/therefore) rather than in a vacuum. That's still short
 * of real cross-post redundancy checking across the whole window — see
 * docs/stub-revisions.md. If the prior post hasn't been compressed yet (or
 * this is the first post), no prior context is sent — the summary just
 * describes this post's beat on its own, same as before this change.
 *
 * Forces the summary through a tool call rather than a plain-text
 * instruction, and validates + retries — a plain system-prompt instruction
 * to this worker model was observed to fail silently (empty output) or
 * ignore the instruction entirely (a full story continuation instead of a
 * summary) in real testing.
 */
async function executeCompressJob(
  db: Database.Database,
  jobId: string,
  targetTextId: string,
  slotCost: number
): Promise<void> {
  try {
    const targetText = getText(db, targetTextId);
    if (!targetText?.genPackage) throw new Error("nothing to compress");

    const targetPage = getPage(db, targetText.pageId);
    const priorPage = targetPage?.prevPageId ? getPage(db, targetPage.prevPageId) : null;
    const priorText = priorPage?.selectedTextId ? getText(db, priorPage.selectedTextId) : null;
    const priorSummary = priorText?.genExtract ?? null;

    const worldbook = getBookByType(db, "worldbook");
    const characterNames = worldbook
      ? listWorldbookEntries(db, worldbook.id, { includeHidden: false })
          .filter((entry) => entry.entryType === "character")
          .map((entry) => entry.name)
      : [];

    const compressMessages: ChatMessage[] = [{ role: "system", content: COMPRESS_SYSTEM_PROMPT }];
    if (characterNames.length) {
      compressMessages.push({ role: "system", content: `Character roster for this story: ${characterNames.join(", ")}.` });
    }
    if (priorSummary) compressMessages.push({ role: "system", content: `What just happened, for context: ${priorSummary}` });
    compressMessages.push({ role: "user", content: targetText.genPackage });

    let summary: string | null = null;
    let usedModel = "";
    let lastError = "unknown error";

    for (let attempt = 1; attempt <= COMPRESS_MAX_ATTEMPTS && !summary; attempt++) {
      try {
        const args = await withModelFallback(getAgentProfile("worker"), (profile) => {
          usedModel = profile.model;
          return callWithForcedTool(profile, compressMessages, SUMMARY_TOOL);
        });
        const candidate = typeof args.summary === "string" ? args.summary.trim() : "";
        if (matchesRefusalPrefix(candidate)) {
          lastError = `model refused on attempt ${attempt}: "${candidate.slice(0, 80)}"`;
        } else if (withinWordLimit(candidate, COMPRESS_MAX_WORDS)) {
          summary = candidate;
        } else {
          lastError = `invalid summary on attempt ${attempt}: "${candidate.slice(0, 80)}"`;
        }
      } catch (err) {
        lastError = `attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (!summary) throw new Error(`compression failed after ${COMPRESS_MAX_ATTEMPTS} attempts — ${lastError}`);

    fillTextExtract(db, targetTextId, summary);
    finishJob(db, jobId, "done", undefined, { model: usedModel, tokenEstimate: Math.ceil(summary.length / 4) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishJob(db, jobId, "failed", message);
  } finally {
    releaseSlots(slotCost);
  }
}

/**
 * Doc: archive blocks are generated by the Editor, not the Worker — this
 * uses editorProfile. Input is the compressed (not verbose) form of each
 * member post, since the point is synthesizing a block-level narrative from
 * the facts, not re-summarizing full prose.
 */
async function executeArchiveJob(
  db: Database.Database,
  jobId: string,
  targetArchiveId: string,
  slotCost: number
): Promise<void> {
  try {
    const archive = getArchive(db, targetArchiveId);
    if (!archive) throw new Error("target archive no longer exists");

    const memberTextIds = listMemberTextIds(db, targetArchiveId);
    const compressedLines = memberTextIds
      .map((id) => getText(db, id)?.genExtract)
      .filter((line): line is string => !!line);
    if (!compressedLines.length) throw new Error("no compressed member content to summarize");

    let summary: string | null = null;
    let usedModel = "";
    let lastError = "unknown error";

    for (let attempt = 1; attempt <= ARCHIVE_MAX_ATTEMPTS && !summary; attempt++) {
      try {
        const args = await withModelFallback(getAgentProfile("editor"), (profile) => {
          usedModel = profile.model;
          return callWithForcedTool(
            profile,
            [
              { role: "system", content: ARCHIVE_SYSTEM_PROMPT },
              { role: "user", content: compressedLines.join("\n") },
            ],
            ARCHIVE_TOOL
          );
        });
        const candidate = typeof args.summary === "string" ? args.summary.trim() : "";
        if (matchesRefusalPrefix(candidate)) {
          lastError = `model refused on attempt ${attempt}: "${candidate.slice(0, 80)}"`;
        } else if (withinWordLimit(candidate, ARCHIVE_MAX_WORDS)) {
          summary = candidate;
        } else {
          lastError = `invalid summary on attempt ${attempt}: "${candidate.slice(0, 80)}"`;
        }
      } catch (err) {
        lastError = `attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (!summary) throw new Error(`archiving failed after ${ARCHIVE_MAX_ATTEMPTS} attempts — ${lastError}`);

    fillArchiveSummary(db, targetArchiveId, summary);
    finishJob(db, jobId, "done", undefined, { model: usedModel, tokenEstimate: Math.ceil(summary.length / 4) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishJob(db, jobId, "failed", message);
  } finally {
    releaseSlots(slotCost);
  }
}
