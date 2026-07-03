import type Database from "better-sqlite3";
import {
  claimNextJob,
  createJob,
  finishJob,
  cancelJob,
  setHordeRequestId,
  setJobModel,
  listRunningHordeJobs,
  type JobRow,
  type JobType,
} from "../db/job-store.js";
import { fillTextExtract, fillTextGeneration, getText } from "../db/text-store.js";
import { getPage, listChronologicalPages, setPageHidden, type PageRow } from "../db/page-store.js";
import { createPageWithText } from "../db/content-store.js";
import { getBookByType, getTagScopeBookId } from "../db/book-store.js";
import { listContentEntries } from "../db/worldbook-store.js";
import { fillArchiveSummary, getArchive, listMemberTextIds } from "../db/archive-store.js";
import { getStoryState } from "../db/story-state-store.js";
import { getGlobalDb } from "../db/global-db.js";
import { getStory } from "../db/story-store.js";
import { tryAcquireSlot, releaseSlot } from "./slots.js";
import { tryAcquireHordeSlot, releaseHordeSlot } from "./horde-slots.js";
import { publishToken, publishProgress, publishDone, publishError, publishCancelled } from "./job-events.js";
import {
  streamInference,
  completeChat,
  withModelFallback,
  FeatherlessError,
  JobCancelledError,
  isReasoningModel,
  type ChatMessage,
} from "../inference/featherless.js";
import { submitTextGeneration, pollTextGeneration } from "../inference/horde.js";
import type { AgentProfile } from "../config.js";
import { assembleAuthorPrompt, assembleKickoffPrompt } from "../services/history.js";
import { applyExtractedWorldbookBlocks } from "../services/worldbook-extraction.js";
import { indexTextAgainstAllTags } from "../services/tag-index.js";
import { getAgentProfile } from "../services/agent-config.js";
import { matchesRefusalPrefix } from "../services/refusal-detection.js";
import {
  EDITOR_SETUP_PROMPT,
  EDITOR_SETUP_WORLDBOOK,
  EDITOR_UPDATE_PROMPT,
  COMPRESS_SYSTEM_PROMPT,
  ARCHIVE_SYSTEM_PROMPT,
  guidedRegenerateNote,
  guidedContinueNote,
} from "../prompts.js";

const SCAN_INTERVAL_MS = 500;
const CLAIMABLE_JOB_TYPES: JobType[] = ["prose", "compress", "archive", "setup", "setup-worldbook"];

/**
 * Guided retry's direction text is explicitly not stored as a post
 * (loremaster.md: "The guidance itself is not stored as a post") — it's
 * job-scoped and ephemeral, threaded through in memory rather than the DB,
 * the same way job-events.ts already handles other non-persisted job state.
 */
type GuidanceIntent = "regenerate" | "continue";
const jobGuidance = new Map<string, { text: string; intent: GuidanceIntent }>();
export function setJobGuidance(jobId: string, guidance: string, intent: GuidanceIntent): void {
  jobGuidance.set(jobId, { text: guidance, intent });
}
const COMPRESS_MAX_ATTEMPTS = 3;
const COMPRESS_MAX_WORDS = 60; // generous ceiling — a real ~20-token summary is well under this; catches "ignored the prompt and kept writing" cases
const ARCHIVE_MAX_ATTEMPTS = 3;
const ARCHIVE_MAX_WORDS = 150; // generous ceiling for a ~60-token narrative summary

// Mirrors worldbook-extraction.ts's BLOCK_PATTERN, single-tag — no backreference needed since
// there's only one tag name to match.
const SUMMARY_PATTERN = /\[SUMMARY\]([\s\S]*?)\[\/SUMMARY\]/;

function extractSummary(text: string): string | null {
  const match = SUMMARY_PATTERN.exec(text);
  const content = match?.[1]?.trim();
  return content || null;
}

function withinWordLimit(text: string, maxWords: number): boolean {
  return !!text && text.split(/\s+/).length <= maxWords;
}

const EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE = 2;

/**
 * Streams a reply with model fallback, treating an empty-but-error-free completion as a
 * retriable failure rather than a valid (if useless) result. Providers sometimes signal
 * overload by closing the stream immediately with zero content chunks instead of a clean
 * HTTP error (observed live with Kimi-K2-Instruct returning a 503 on a plain non-streaming
 * call, moments after a streaming call to the same model produced zero tokens with no
 * error) — without this, that failure mode would silently bypass withModelFallback
 * entirely, since the emptiness was only ever checked after it had already returned.
 *
 * For a reasoning model specifically (see isReasoningModel), the same empty-completion
 * failure has a known, reproducible cause: its chat template lets the model decide, per turn,
 * whether/how to open its own `<think>` block, and under temperature the very first sampled
 * token can land on an immediate close-and-stop instead — confirmed live by replaying an
 * identical failing request repeatedly. Prefilling the assistant turn with an already-open
 * `<think>\n` removes that coin-flip (same technique SillyTavern's reasoning-model presets
 * use). EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE is a belt-and-suspenders retry on top of that
 * for whatever variance the prefill doesn't catch, before handing off to the next fallback
 * candidate (if any).
 */
async function streamWithFallback(
  profile: AgentProfile,
  messages: ChatMessage[],
  jobId: string,
  signal?: AbortSignal
): Promise<{ text: string; model: string }> {
  let reply = "";
  let usedModel = profile.model;
  await withModelFallback(profile, async (candidate) => {
    usedModel = candidate.model;
    const candidateMessages = isReasoningModel(candidate.model)
      ? [...messages, { role: "assistant" as const, content: "<think>\n" }]
      : messages;

    for (let attempt = 1; attempt <= EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE; attempt++) {
      reply = "";
      try {
        await new Promise<void>((resolve, reject) => {
          void streamInference(
            candidate,
            candidateMessages,
            {
              onToken: (text) => {
                reply += text;
                publishToken(jobId, text);
              },
              onDone: () => {
                if (reply.trim()) resolve();
                else reject(new FeatherlessError(503, `${candidate.model} returned an empty completion`));
              },
              onError: reject,
            },
            { signal }
          );
        });
        return;
      } catch (err) {
        if (err instanceof JobCancelledError) throw err;
        const isEmptyCompletion = err instanceof FeatherlessError && err.message.includes("empty completion");
        if (!isEmptyCompletion || attempt === EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE) throw err;
      }
    }
  });
  return { text: reply, model: usedModel };
}

// Deliberately not gated by src/middleware/session-guard.ts — this loop isn't an HTTP
// request, and per the single-active-session design a job a since-superseded session
// started still runs to completion; claiming only changes who's allowed to submit *new*
// interactions, not what happens to work already in flight.
let timer: NodeJS.Timeout | null = null;
const trackedDbs = new Map<string, Database.Database>();

/** One AbortController per currently-running job, so a cancel request can actually abort its in-flight Featherless call instead of just flipping a DB flag. Populated when a job is claimed, deleted in its executor's `finally`. */
const runningControllers = new Map<string, AbortController>();

/**
 * Aborts a running job's in-flight call. Returns false if the job isn't currently running here
 * (already terminal, still pending, or a job type with no mid-flight cancel support) — callers
 * should fall back to marking it cancelled directly in that case.
 *
 * Horde jobs deliberately fall into the "no mid-flight cancel support" bucket, same as
 * compress/archive today — explicit scope decision (2026-07-03): a request that's already
 * submitted just runs to completion rather than chasing the narrow, hard-to-hit window between
 * "submitted" and "resolved" that real cancellation would require synchronizing against.
 */
export function requestJobCancel(jobId: string): boolean {
  const controller = runningControllers.get(jobId);
  if (!controller) return false;
  controller.abort(new JobCancelledError());
  return true;
}

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
  const globalDb = getGlobalDb();
  for (const [storyId, db] of trackedDbs) {
    // Belt-and-suspenders on top of untrackStoryDb: a closed connection (or any other
    // per-story fault) must never take down the shared setInterval loop that every other
    // tracked story depends on. An uncaught throw here is fatal to the whole process — this
    // is exactly what happened before untrackStoryDb existed (see stub-revisions.md).
    try {
      const story = getStory(globalDb, storyId);
      if (!story) {
        trackedDbs.delete(storyId);
        continue;
      }
      scanStory(db, story.ownerUserId);
      scanHordeJobs(db);
    } catch (err) {
      if (!db.open) trackedDbs.delete(storyId);
      console.error(`pipeline scan failed for story ${storyId}:`, err instanceof Error ? err.message : err);
    }
  }
}

function scanStory(db: Database.Database, userId: string): void {
    const job = claimNextJob(db, CLAIMABLE_JOB_TYPES);
    if (!job) return;

    // Horde branch (prose only for now — see docs/roadmap.md's P5a): skips tryAcquireSlot
    // entirely (Featherless-specific, backed by concurrency-feed.ts's account signal that
    // doesn't exist for Horde) and submits-then-returns rather than awaiting completion here,
    // since a Horde generation can take minutes and this tick can't block on it. The job stays
    // 'running' with a horde_request_id recorded; scanHordeJobs (P5b) polls it to resolution
    // on later ticks.
    if (job.jobType === "prose" && job.targetTextId && getAgentProfile(userId, "author").provider === "horde") {
      if (!tryAcquireHordeSlot(job.id)) {
        db.prepare(`UPDATE jobs SET status = 'pending', started_at = NULL WHERE id = ?`).run(job.id);
        return;
      }
      void executeHordeProseSubmit(db, userId, job.id, job.targetTextId);
      return;
    }

    if (!tryAcquireSlot(job.id, job.slotCost)) {
      // Claimed but no slot free right now — put it back rather than block the scan loop.
      db.prepare(`UPDATE jobs SET status = 'pending', started_at = NULL WHERE id = ?`).run(job.id);
      return;
    }
    if (job.jobType === "compress" && job.targetTextId) {
      void executeCompressJob(db, userId, job.id, job.targetTextId);
    } else if (job.jobType === "archive" && job.targetArchiveId) {
      void executeArchiveJob(db, userId, job.id, job.targetArchiveId);
    } else if (job.jobType === "prose" && job.targetTextId) {
      const controller = new AbortController();
      runningControllers.set(job.id, controller);
      void executeProseJob(db, userId, job.id, job.targetTextId, controller.signal);
    } else if (job.jobType === "setup" && job.targetTextId) {
      const controller = new AbortController();
      runningControllers.set(job.id, controller);
      void executeSetupJob(db, userId, job.id, job.targetTextId, controller.signal);
    } else if (job.jobType === "setup-worldbook" && job.targetTextId) {
      const controller = new AbortController();
      runningControllers.set(job.id, controller);
      void executeSetupWorldbookJob(db, userId, job.id, job.targetTextId, controller.signal);
    } else {
      finishJob(db, job.id, "failed", `job ${job.id} (${job.jobType}) has no valid target`);
      releaseSlot(job.id);
    }
}

/**
 * Shared by both the Featherless (streamed, synchronous-await) and Horde (submit-then-poll)
 * prose paths — the prompt assembly itself doesn't care how the reply eventually comes back.
 */
function buildProseHistory(
  db: Database.Database,
  userId: string,
  jobId: string,
  targetTextId: string
): { history: ChatMessage[]; targetPage: PageRow } {
  const targetText = getText(db, targetTextId);
  if (!targetText) throw new Error("target text no longer exists");
  const targetPage = getPage(db, targetText.pageId);
  if (!targetPage) throw new Error("target page no longer exists");

  // The kickoff page (and any later Retry/Guided Retry of it) always generates from the
  // worldbook alone, never the setup conversation's chat log — checked by page identity,
  // not current phase, since phase moves on to "story" immediately after kickoff fires but
  // the opening post can still be regenerated any time after that.
  const kickoffPageId = getStoryState(db).kickoffPageId;
  let history: ChatMessage[];
  if (targetPage.id === kickoffPageId) {
    const worldbook = getBookByType(db, "worldbook");
    if (!worldbook) throw new Error("worldbook not found");
    history = assembleKickoffPrompt(db, worldbook.id);
  } else {
    history = assembleAuthorPrompt(db, userId, targetPage.bookId, targetPage.prevPageId);
  }

  const guidance = jobGuidance.get(jobId);
  if (guidance) {
    jobGuidance.delete(jobId);
    const content =
      guidance.intent === "continue"
        ? guidedContinueNote(guidance.text, "story")
        : guidedRegenerateNote(guidance.text);
    history = [...history, { role: "system", content }];
  }

  return { history, targetPage };
}

async function executeProseJob(
  db: Database.Database,
  userId: string,
  jobId: string,
  targetTextId: string,
  signal: AbortSignal
): Promise<void> {
  const startedAt = Date.now();
  try {
    const { history, targetPage } = buildProseHistory(db, userId, jobId, targetTextId);
    const { text: fullText, model } = await streamWithFallback(getAgentProfile(userId, "author"), history, jobId, signal);

    // chars/4 is the same rough estimate used for prompt budgeting elsewhere (see history.ts) —
    // not a real tokenizer, good enough for the Logs telemetry view's ballpark numbers.
    const tokenEstimate = Math.ceil(fullText.length / 4);
    const metrics = { elapsedMs: Date.now() - startedAt, tokenEstimate };
    fillTextGeneration(db, targetTextId, { genPackage: fullText, genMetrics: JSON.stringify(metrics) });
    indexTextAgainstAllTags(db, getTagScopeBookId(db, targetPage.bookId), targetTextId);
    finishJob(db, jobId, "done", undefined, { model, tokenEstimate });
    publishDone(jobId, fullText);
  } catch (err) {
    if (err instanceof JobCancelledError) {
      cancelJob(db, jobId);
      publishCancelled(jobId);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      finishJob(db, jobId, "failed", message);
      publishError(jobId, message);
    }
  } finally {
    releaseSlot(jobId);
    runningControllers.delete(jobId);
  }
}

/**
 * P5a: submit-then-return only, no completion handling here — Horde has no synchronous
 * completion endpoint, so unlike executeProseJob this doesn't await a reply. The job stays
 * 'running' with a horde_request_id recorded once the submit call resolves; scanHordeJobs
 * (P5b) owns polling it to done/faulted on later scan ticks and doing the actual
 * fillTextGeneration/finishJob/publishDone tail. releaseHordeSlot happens there too, not
 * here — the slot represents "still awaiting a result," which is true well past this
 * function's return.
 */
async function executeHordeProseSubmit(db: Database.Database, userId: string, jobId: string, targetTextId: string): Promise<void> {
  try {
    const { history } = buildProseHistory(db, userId, jobId, targetTextId);
    const profile = getAgentProfile(userId, "author");
    const { id: requestId } = await submitTextGeneration(profile, history);
    setHordeRequestId(db, jobId, requestId);
    setJobModel(db, jobId, profile.model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishJob(db, jobId, "failed", message);
    publishError(jobId, message);
    releaseHordeSlot(jobId);
  }
}

// How long a request is allowed to sit with is_possible: false (a live, continuously
// recomputed "no worker currently matches this request" signal, not a one-time rejection —
// see docs/roadmap.md's Horde research notes) before it's treated as a real failure rather
// than a transient dip in pool availability.
const HORDE_IMPOSSIBLE_TIMEOUT_MS = 5 * 60_000;
const hordeImpossibleSince = new Map<string, number>();

function hordeJobTerminal(jobId: string): void {
  hordeImpossibleSince.delete(jobId);
  releaseHordeSlot(jobId);
}

/**
 * The "come back later and check on this" half of Horde support — claimNextJob only ever
 * looks at 'pending' rows, so a submitted-but-unresolved Horde job needs its own query
 * (listRunningHordeJobs) to be found again on a later tick. Runs every scan tick alongside
 * scanStory; each job's own poll is fire-and-forget so one slow/stuck poll can't block
 * checking on the others.
 */
function scanHordeJobs(db: Database.Database): void {
  for (const job of listRunningHordeJobs(db)) {
    void resolveHordeJob(db, job);
  }
}

async function resolveHordeJob(db: Database.Database, job: JobRow): Promise<void> {
  if (!job.hordeRequestId || !job.targetTextId) return;
  const targetTextId = job.targetTextId;

  let status;
  try {
    status = await pollTextGeneration(job.hordeRequestId);
  } catch (err) {
    // Transient poll failure (network hiccup, rate limit) — leave the job running and try
    // again next tick rather than failing it over what might be a momentary blip.
    console.error(`horde poll failed for job ${job.id}:`, err instanceof Error ? err.message : err);
    return;
  }

  if (status.faulted) {
    hordeJobTerminal(job.id);
    finishJob(db, job.id, "failed", "Horde generation faulted");
    publishError(job.id, "Horde generation faulted");
    return;
  }

  if (status.done) {
    const fullText = status.text ?? "";
    const targetText = getText(db, targetTextId);
    const targetPage = targetText ? getPage(db, targetText.pageId) : null;
    const tokenEstimate = Math.ceil(fullText.length / 4);

    fillTextGeneration(db, targetTextId, { genPackage: fullText, genMetrics: JSON.stringify({ tokenEstimate }) });
    if (targetPage) indexTextAgainstAllTags(db, getTagScopeBookId(db, targetPage.bookId), targetTextId);

    hordeJobTerminal(job.id);
    // job.model was recorded at submit time (see executeHordeProseSubmit) — reading it back
    // here, rather than re-querying getAgentProfile("author"), is what keeps attribution
    // correct if the user reordered/edited Agents configs while this job was in flight.
    finishJob(db, job.id, "done", undefined, { model: job.model ?? undefined, tokenEstimate });
    publishDone(job.id, fullText);
    return;
  }

  if (!status.isPossible) {
    const firstSeen = hordeImpossibleSince.get(job.id) ?? Date.now();
    hordeImpossibleSince.set(job.id, firstSeen);
    if (Date.now() - firstSeen > HORDE_IMPOSSIBLE_TIMEOUT_MS) {
      hordeJobTerminal(job.id);
      finishJob(db, job.id, "failed", "no worker currently available for this model");
      publishError(job.id, "no worker currently available for this model");
      return;
    }
    publishProgress(job.id, "No worker currently available for this model…");
    return;
  }

  hordeImpossibleSince.delete(job.id);
  publishProgress(job.id, `Queued on AI Horde — position ${status.queuePosition}, ~${status.waitTime}s`);
}

/**
 * Every turn in an OOC/setup conversation, verbatim (no tiering — these are short-lived), up
 * to and including the given page. Filters to hidden pages specifically — every setup/OOC page
 * is hidden the moment it's created, while in-character pages never are, so this is what scopes
 * the Editor's context to just OOC content even when it's interleaved with IC content on the
 * same page chain. `sincePageId`, when given, additionally scopes the *start* of the window —
 * this is what makes a post-kickoff "update session" fresh (no memory of earlier update
 * sessions) rather than reading the story's entire OOC history back to its original setup.
 */
function buildSetupConversation(
  db: Database.Database,
  logbookId: string,
  uptoPageId: string | null,
  sincePageId?: string | null
): ChatMessage[] {
  const pages = listChronologicalPages(db, logbookId).filter((p) => p.hidden);
  const sinceIdx = sincePageId ? pages.findIndex((p) => p.id === sincePageId) : -1;
  const scoped = sinceIdx >= 0 ? pages.slice(sinceIdx) : pages;
  const cutoffIdx = uptoPageId ? scoped.findIndex((p) => p.id === uptoPageId) : scoped.length - 1;
  const historyPages = cutoffIdx >= 0 ? scoped.slice(0, cutoffIdx + 1) : scoped;

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
 * Read-only reference material for a post-kickoff update session: the in-character story so
 * far, folded into one system-role block rather than interleaved as raw user/assistant turns
 * (which would otherwise confuse the Editor's own OOC role alternation). Reuses
 * assembleAuthorPrompt's existing tiered history assembly rather than building a second one.
 */
function buildIcContextBlock(db: Database.Database, userId: string, logbookId: string): ChatMessage | null {
  const currentPageId = getStoryState(db).currentPageId;
  const icMessages = assembleAuthorPrompt(db, userId, logbookId, currentPageId).slice(1);
  if (!icMessages.length) return null;
  const icLines = icMessages.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
  return {
    role: "system",
    content: `For reference, here is the in-character story so far (read-only — you are not continuing it, just aware of it):\n\n${icLines}`,
  };
}

/**
 * The Editor's setup/update turn. Pre-kickoff, this is dual-pass: the conversational reply
 * (EDITOR_SETUP_PROMPT) lands here, then a second, separate worldbook-authoring pass
 * (EDITOR_SETUP_WORLDBOOK) is queued as its own job/page — matching those being two distinct
 * prompts in prompts.md. Post-kickoff "update session" turns are single-pass: EDITOR_UPDATE_PROMPT
 * already embeds the bracket schema inline, so the one reply is scanned for blocks directly,
 * no second page/job. If worldbook extraction fails, the conversational reply the user already
 * sees still stands — a background hiccup shouldn't erase what's already on screen.
 */
async function executeSetupJob(
  db: Database.Database,
  userId: string,
  jobId: string,
  targetTextId: string,
  signal: AbortSignal
): Promise<void> {
  try {
    const targetText = getText(db, targetTextId);
    if (!targetText) throw new Error("target text no longer exists");
    const targetPage = getPage(db, targetText.pageId);
    if (!targetPage) throw new Error("target page no longer exists");

    const worldbook = getBookByType(db, "worldbook");
    if (!worldbook) throw new Error("worldbook not found");

    const { kickoffPageId, oocSessionStartPageId } = getStoryState(db);
    const isUpdateSession = !!kickoffPageId;

    let conversation: ChatMessage[];
    const editorMessages: ChatMessage[] = [];
    if (isUpdateSession) {
      editorMessages.push({ role: "system", content: EDITOR_UPDATE_PROMPT });
      const icContextBlock = buildIcContextBlock(db, userId, targetPage.bookId);
      if (icContextBlock) editorMessages.push(icContextBlock);
      conversation = buildSetupConversation(db, targetPage.bookId, targetPage.prevPageId, oocSessionStartPageId);
    } else {
      editorMessages.push({ role: "system", content: EDITOR_SETUP_PROMPT });
      conversation = buildSetupConversation(db, targetPage.bookId, targetPage.prevPageId);
    }
    editorMessages.push(...conversation);

    const guidance = jobGuidance.get(jobId);
    if (guidance) {
      jobGuidance.delete(jobId);
      const content =
        guidance.intent === "continue"
          ? guidedContinueNote(guidance.text, "conversation")
          : guidedRegenerateNote(guidance.text);
      editorMessages.push({ role: "system", content });
    }

    const { text: reply, model } = await streamWithFallback(getAgentProfile(userId, "editor"), editorMessages, jobId, signal);

    const tokenEstimate = Math.ceil(reply.length / 4);
    fillTextGeneration(db, targetTextId, { genPackage: reply, genMetrics: JSON.stringify({ tokenEstimate }) });

    let followUp: { jobId: string; pageId: string } | undefined;
    if (isUpdateSession) {
      // Single-pass: EDITOR_UPDATE_PROMPT's own reply may itself contain bracket blocks.
      try {
        applyExtractedWorldbookBlocks(db, worldbook.id, getTagScopeBookId(db, targetPage.bookId), reply);
      } catch (err) {
        console.error(`[setup ${jobId}] worldbook extraction failed, reply still stands:`, err);
      }
    } else {
      // Dual-pass: queue a separate worldbook-authoring pass as its own visible message.
      try {
        const { page: worldbookPage, text: worldbookText } = createPageWithText(db, {
          bookId: targetPage.bookId,
          prevPageId: targetPage.id,
          role: "agent",
        });
        setPageHidden(db, worldbookPage.id, true);
        const worldbookJob = createJob(db, {
          targetTextId: worldbookText.id,
          jobType: "setup-worldbook",
          slotCost: getAgentProfile(userId, "editor").concurrencyCost,
          priority: 10,
        });
        followUp = { jobId: worldbookJob.id, pageId: worldbookPage.id };
      } catch (err) {
        console.error(`[setup ${jobId}] failed to queue worldbook-authoring pass, reply still stands:`, err);
      }
    }

    finishJob(db, jobId, "done", undefined, { model, tokenEstimate });
    publishDone(jobId, reply, followUp);
  } catch (err) {
    if (err instanceof JobCancelledError) {
      cancelJob(db, jobId);
      publishCancelled(jobId);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      finishJob(db, jobId, "failed", message);
      publishError(jobId, message);
    }
  } finally {
    releaseSlot(jobId);
    runningControllers.delete(jobId);
  }
}

/**
 * The pre-kickoff dual-pass's second half: a separate Editor generation using
 * EDITOR_SETUP_WORLDBOOK, whose raw bracket-tagged output IS the visible log message (the
 * player sees it and it gets highlighted client-side) — not a hidden side-channel the way the
 * old tool-calling extraction pass was. Regex-extracts blocks from its own output immediately
 * after landing; zero blocks found is a normal outcome, not an error.
 */
async function executeSetupWorldbookJob(
  db: Database.Database,
  userId: string,
  jobId: string,
  targetTextId: string,
  signal: AbortSignal
): Promise<void> {
  try {
    const targetText = getText(db, targetTextId);
    if (!targetText) throw new Error("target text no longer exists");
    const targetPage = getPage(db, targetText.pageId);
    if (!targetPage) throw new Error("target page no longer exists");

    const worldbook = getBookByType(db, "worldbook");
    if (!worldbook) throw new Error("worldbook not found");

    const replyPage = targetPage.prevPageId ? getPage(db, targetPage.prevPageId) : null;
    const replyText = replyPage?.selectedTextId ? getText(db, replyPage.selectedTextId) : null;

    const conversation = buildSetupConversation(db, targetPage.bookId, replyPage?.prevPageId ?? null);
    if (replyText?.genPackage) conversation.push({ role: "assistant", content: replyText.genPackage });

    const worldbookMessages: ChatMessage[] = [{ role: "system", content: EDITOR_SETUP_WORLDBOOK }, ...conversation];
    const { text: rawText, model } = await streamWithFallback(getAgentProfile(userId, "editor"), worldbookMessages, jobId, signal);

    const tokenEstimate = Math.ceil(rawText.length / 4);
    fillTextGeneration(db, targetTextId, { genPackage: rawText, genMetrics: JSON.stringify({ tokenEstimate }) });

    try {
      applyExtractedWorldbookBlocks(db, worldbook.id, getTagScopeBookId(db, targetPage.bookId), rawText);
    } catch (err) {
      console.error(`[setup-worldbook ${jobId}] worldbook extraction failed, message still stands:`, err);
    }

    finishJob(db, jobId, "done", undefined, { model, tokenEstimate });
    publishDone(jobId, rawText);
  } catch (err) {
    if (err instanceof JobCancelledError) {
      cancelJob(db, jobId);
      publishCancelled(jobId);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      finishJob(db, jobId, "failed", message);
      publishError(jobId, message);
    }
  } finally {
    releaseSlot(jobId);
    runningControllers.delete(jobId);
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
  userId: string,
  jobId: string,
  targetTextId: string
): Promise<void> {
  const startedAt = Date.now();
  try {
    const targetText = getText(db, targetTextId);
    if (!targetText?.genPackage) throw new Error("nothing to compress");

    const targetPage = getPage(db, targetText.pageId);
    const priorPage = targetPage?.prevPageId ? getPage(db, targetPage.prevPageId) : null;
    const priorText = priorPage?.selectedTextId ? getText(db, priorPage.selectedTextId) : null;
    const priorSummary = priorText?.genExtract ?? null;

    const worldbook = getBookByType(db, "worldbook");
    const contentEntries = worldbook ? listContentEntries(db, worldbook.id) : [];

    const compressMessages: ChatMessage[] = [{ role: "system", content: COMPRESS_SYSTEM_PROMPT }];
    if (contentEntries.length) {
      compressMessages.push({
        role: "system",
        content: `Worldbook context for this story:\n${contentEntries.map((e) => e.content).join("\n\n")}`,
      });
    }
    if (priorSummary) compressMessages.push({ role: "system", content: `What just happened, for context: ${priorSummary}` });
    compressMessages.push({ role: "user", content: targetText.genPackage });

    let summary: string | null = null;
    let usedModel = "";
    let lastError = "unknown error";

    for (let attempt = 1; attempt <= COMPRESS_MAX_ATTEMPTS && !summary; attempt++) {
      try {
        const rawText = await withModelFallback(getAgentProfile(userId, "worker"), (profile) => {
          usedModel = profile.model;
          return completeChat(profile, compressMessages);
        });
        const candidate = extractSummary(rawText) ?? "";
        if (matchesRefusalPrefix(userId, candidate)) {
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

    const tokenEstimate = Math.ceil(summary.length / 4);
    const compressMetrics = JSON.stringify({ elapsedMs: Date.now() - startedAt, tokenEstimate });
    fillTextExtract(db, targetTextId, summary, compressMetrics);
    finishJob(db, jobId, "done", undefined, { model: usedModel, tokenEstimate });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishJob(db, jobId, "failed", message);
  } finally {
    releaseSlot(jobId);
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
  userId: string,
  jobId: string,
  targetArchiveId: string
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
        const rawText = await withModelFallback(getAgentProfile(userId, "editor"), (profile) => {
          usedModel = profile.model;
          return completeChat(profile, [
            { role: "system", content: ARCHIVE_SYSTEM_PROMPT },
            { role: "user", content: compressedLines.join("\n") },
          ]);
        });
        const candidate = extractSummary(rawText) ?? "";
        if (matchesRefusalPrefix(userId, candidate)) {
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
    releaseSlot(jobId);
  }
}
