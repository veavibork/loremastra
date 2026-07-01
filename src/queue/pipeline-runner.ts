import type Database from "better-sqlite3";
import { claimNextJob, finishJob, type JobType } from "../db/job-store.js";
import { fillTextExtract, fillTextGeneration, getText } from "../db/text-store.js";
import { getPage, listChronologicalPages } from "../db/page-store.js";
import { getBookByType, getTagScopeBookId } from "../db/book-store.js";
import { fillArchiveSummary, getArchive, listMemberTextIds } from "../db/archive-store.js";
import { getStoryState } from "../db/story-state-store.js";
import { tryAcquireSlots, releaseSlots } from "./slots.js";
import { publishToken, publishDone, publishError } from "./job-events.js";
import { streamInference, callWithForcedTool, withModelFallback, type ChatMessage, type ToolDefinition } from "../inference/featherless.js";
import { assembleAuthorPrompt, assembleKickoffPrompt } from "../services/history.js";
import { runEditorSetupTurn } from "../services/setup.js";
import { indexTextAgainstAllTags } from "../services/tag-index.js";
import { getAgentProfile } from "../services/agent-config.js";

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

const COMPRESS_SYSTEM_PROMPT =
  "You compress a single roleplay post into a short, dense, factual summary of about 20 tokens. " +
  "State only what happened. If you're given what happened just before this post, frame this post as " +
  "what changed or followed from that (but/therefore) rather than an isolated fact. No commentary, no " +
  "scene-setting, no dialogue quoting.";

const ARCHIVE_SYSTEM_PROMPT =
  "You write a short narrative summary (about 60 tokens) of a block of roleplay posts, given as a " +
  "sequence of factual compressed lines. Weave them into a causal throughline — this happened, BUT this " +
  "complicated it, THEREFORE this followed — not a flat list of events. Preserve who did what to whom; " +
  "don't blur which character acted and which reacted. No commentary, no meta-text.";

const SUMMARY_TOOL: ToolDefinition = {
  name: "submit_summary",
  description: "Submit the compressed factual summary of the post.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "A short, dense, factual summary of about 20 tokens. State only what happened.",
      },
    },
    required: ["summary"],
  },
};

const ARCHIVE_TOOL: ToolDefinition = {
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

let timer: NodeJS.Timeout | null = null;
const trackedDbs = new Map<string, Database.Database>();

/** The pipeline runner only scans stories the API has actually touched this process lifetime — fine for a handful of users, one active story each. */
export function trackStoryDb(storyId: string, db: Database.Database): void {
  trackedDbs.set(storyId, db);
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
  for (const db of trackedDbs.values()) {
    const job = claimNextJob(db, CLAIMABLE_JOB_TYPES);
    if (!job) continue;
    if (!tryAcquireSlots(job.slotCost)) {
      // Claimed but no slot free right now — put it back rather than block the scan loop.
      db.prepare(`UPDATE jobs SET status = 'pending', started_at = NULL WHERE id = ?`).run(job.id);
      continue;
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

    let fullText = "";

    await withModelFallback(getAgentProfile("author"), (profile) => {
      fullText = ""; // reset in case a prior candidate model failed before streaming any tokens
      return new Promise<void>((resolve, reject) => {
        void streamInference(profile, history, {
          onToken: (text) => {
            fullText += text;
            publishToken(jobId, text);
          },
          onDone: resolve,
          onError: reject,
        });
      });
    });

    if (!fullText.trim()) {
      throw new Error("model returned an empty reply");
    }

    // chars/4 is the same rough estimate used for prompt budgeting elsewhere (see history.ts) —
    // not a real tokenizer, good enough for the Logs telemetry view's ballpark numbers.
    const metrics = { elapsedMs: Date.now() - startedAt, tokenEstimate: Math.ceil(fullText.length / 4) };
    fillTextGeneration(db, targetTextId, { genPackage: fullText, genMetrics: JSON.stringify(metrics) });
    indexTextAgainstAllTags(db, getTagScopeBookId(db, targetPage.bookId), targetTextId);
    finishJob(db, jobId, "done");
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
 * The Editor's setup turn: unlike prose/compress/archive, this isn't a single
 * inference call — runEditorSetupTurn loops through tool calls (creating or
 * updating worldbook entries and tags) until the model responds with plain
 * text, and that text is what gets stored as this turn's reply.
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

    const conversation = buildSetupConversation(db, targetPage.bookId, targetPage.prevPageId);
    const reply = await runEditorSetupTurn(db, worldbook.id, getTagScopeBookId(db, targetPage.bookId), conversation);

    fillTextGeneration(db, targetTextId, { genPackage: reply });
    finishJob(db, jobId, "done");
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

    const compressMessages: ChatMessage[] = [{ role: "system", content: COMPRESS_SYSTEM_PROMPT }];
    if (priorSummary) compressMessages.push({ role: "system", content: `What just happened, for context: ${priorSummary}` });
    compressMessages.push({ role: "user", content: targetText.genPackage });

    let summary: string | null = null;
    let lastError = "unknown error";

    for (let attempt = 1; attempt <= COMPRESS_MAX_ATTEMPTS && !summary; attempt++) {
      try {
        const args = await withModelFallback(getAgentProfile("worker"), (profile) =>
          callWithForcedTool(profile, compressMessages, SUMMARY_TOOL)
        );
        const candidate = typeof args.summary === "string" ? args.summary.trim() : "";
        if (withinWordLimit(candidate, COMPRESS_MAX_WORDS)) {
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
    finishJob(db, jobId, "done");
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
    let lastError = "unknown error";

    for (let attempt = 1; attempt <= ARCHIVE_MAX_ATTEMPTS && !summary; attempt++) {
      try {
        const args = await withModelFallback(getAgentProfile("editor"), (profile) =>
          callWithForcedTool(
            profile,
            [
              { role: "system", content: ARCHIVE_SYSTEM_PROMPT },
              { role: "user", content: compressedLines.join("\n") },
            ],
            ARCHIVE_TOOL
          )
        );
        const candidate = typeof args.summary === "string" ? args.summary.trim() : "";
        if (withinWordLimit(candidate, ARCHIVE_MAX_WORDS)) {
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
    finishJob(db, jobId, "done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishJob(db, jobId, "failed", message);
  } finally {
    releaseSlots(slotCost);
  }
}
