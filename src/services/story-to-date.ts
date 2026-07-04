import type Database from "better-sqlite3";
import { createJob, hasActiveJobForStoryToDate } from "../db/job-store.js";
import { getStoryState } from "../db/story-state-store.js";
import {
  createStoryToDateSegment,
  getStoryToDateSegment,
  hasActiveJobForStoryToDateSegment,
  listStoryToDateSegments,
} from "../db/story-to-date-store.js";
import { getAgentProfile } from "./agent-config.js";
import { assembleAuthorPrompt } from "./history.js";
import {
  buildStoryCorpus,
  estimateTokens,
  mergeStoryToDate,
  type StoryBlockKind,
  type StoryToDateSegment,
} from "./story-to-date-corpus.js";

export const STORY_TO_DATE_TRIGGER = 0.8;
export const STORY_TO_DATE_INPUT_CUTOFF = 0.8;

function segmentsForMerge(rows: ReturnType<typeof listStoryToDateSegments>): StoryToDateSegment[] {
  return rows
    .filter((s) => s.content?.trim() && !s.broken)
    .map((s) => ({
      kind: s.kind,
      content: s.content!.trim(),
      coverageThroughPost: s.coverageThroughIcPost ?? 0,
      coveragePageId: s.coveragePageId,
    }));
}

export function estimateAssembledAuthorTokens(
  db: Database.Database,
  userId: string,
  logbookId: string,
  fromPageId: string | null
): number {
  const messages = assembleAuthorPrompt(db, userId, logbookId, fromPageId);
  return messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ""), 0);
}

export function wouldTriggerStoryToDateJob(
  db: Database.Database,
  userId: string,
  logbookId: string,
  fromPageId: string | null
): boolean {
  const author = getAgentProfile(userId, "author");
  const usable = author.contextLimit - author.responseLimit;
  const assembled = estimateAssembledAuthorTokens(db, userId, logbookId, fromPageId);
  return assembled >= usable * STORY_TO_DATE_TRIGGER;
}

function hasPendingStoryToDateJob(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM jobs WHERE job_type = 'story-to-date' AND status IN ('pending', 'running') LIMIT 1`
    )
    .get();
  return !!row;
}

function nextSegmentKind(db: Database.Database, logbookId: string): StoryBlockKind | null {
  const ready = listStoryToDateSegments(db, logbookId).filter((s) => s.content?.trim() && !s.broken);
  if (!ready.length) return "begins";
  const incomplete = listStoryToDateSegments(db, logbookId).find((s) => !s.content?.trim() && !s.broken);
  if (incomplete) return null;
  return "continues";
}

/** Queue a story-to-date Editor job when assembled Author prompt crosses the trigger threshold. */
export function enqueueEligibleStoryToDateJob(
  db: Database.Database,
  userId: string,
  logbookId: string,
  storyId: string,
  fromPageId: string | null = null
): string | null {
  const state = getStoryState(db);
  if (state.phase !== "story" || !state.kickoffPageId) return null;
  if (!wouldTriggerStoryToDateJob(db, userId, logbookId, fromPageId)) return null;
  if (hasPendingStoryToDateJob(db)) return null;

  const kind = nextSegmentKind(db, logbookId);
  if (!kind) return null;

  const segments = listStoryToDateSegments(db, logbookId);
  const seq = segments.length ? Math.max(...segments.map((s) => s.seq)) + 1 : 0;

  if (kind === "continues") {
    const last = listStoryToDateSegments(db, logbookId)
      .filter((s) => s.content?.trim() && !s.broken)
      .sort((a, b) => b.seq - a.seq)[0];
    if (!last?.coveragePageId) return null;

    const author = getAgentProfile(userId, "author");
    const editor = getAgentProfile(userId, "editor");
    const priorStoryToDate = mergeStoryToDate(segmentsForMerge(listStoryToDateSegments(db, logbookId)));
    const corpus = buildStoryCorpus(db, storyId, logbookId, {
      contextLimit: editor.contextLimit,
      responseLimit: editor.responseLimit,
      inputCutoff: STORY_TO_DATE_INPUT_CUTOFF,
      afterPageId: last.coveragePageId,
      priorStoryToDate,
    });
    if (!corpus.includedPosts.length) return null;
  }

  const segment = createStoryToDateSegment(db, { bookId: logbookId, kind, seq });
  const editor = getAgentProfile(userId, "editor");
  createJob(db, {
    targetStoryToDateId: segment.id,
    jobType: "story-to-date",
    priority: 5,
    slotCost: editor.concurrencyCost,
  });
  return segment.id;
}

export function enqueuePendingStoryToDateJobs(db: Database.Database, userId: string, logbookId: string): number {
  let n = 0;
  for (const seg of listStoryToDateSegments(db, logbookId)) {
    if (seg.content?.trim() || seg.broken) continue;
    if (hasActiveJobForStoryToDateSegment(db, seg.id)) continue;
    const editor = getAgentProfile(userId, "editor");
    createJob(db, {
      targetStoryToDateId: seg.id,
      jobType: "story-to-date",
      priority: 5,
      slotCost: editor.concurrencyCost,
    });
    n++;
  }
  return n;
}

export function requeueStoryToDateSegment(db: Database.Database, userId: string, segmentId: string): void {
  const seg = getStoryToDateSegment(db, segmentId);
  if (!seg || seg.broken) throw new Error("segment not found or broken");
  if (hasActiveJobForStoryToDateSegment(db, segmentId)) return;
  const editor = getAgentProfile(userId, "editor");
  createJob(db, {
    targetStoryToDateId: segmentId,
    jobType: "story-to-date",
    priority: 5,
    slotCost: editor.concurrencyCost,
  });
}

/** Queue a Worker naming job for a segment that has content but no title yet. */
export function enqueueStoryToDateNameJob(db: Database.Database, userId: string, segmentId: string): boolean {
  const seg = getStoryToDateSegment(db, segmentId);
  if (!seg?.content?.trim() || seg.broken) return false;
  if (seg.name?.trim()) return false;
  if (hasActiveJobForStoryToDate(db, segmentId, "archive-name")) return false;
  const worker = getAgentProfile(userId, "worker");
  createJob(db, {
    targetStoryToDateId: segmentId,
    jobType: "archive-name",
    priority: -1,
    slotCost: worker.concurrencyCost,
  });
  return true;
}

export function enqueuePendingStoryToDateNameJobs(db: Database.Database, userId: string, logbookId: string): number {
  let n = 0;
  for (const seg of listStoryToDateSegments(db, logbookId, { includeHidden: true, includeBroken: true })) {
    if (enqueueStoryToDateNameJob(db, userId, seg.id)) n++;
  }
  return n;
}
