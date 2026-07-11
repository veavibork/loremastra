import type Database from "better-sqlite3";
import { hasActiveJobForStoryToDate, listActiveJobs, type JobRow, type JobType } from "../db/job-store.js";
import { listStoryToDateSegments } from "../db/story-to-date-store.js";
import { estimateTokens, countIcPosts, sanitizeStoryBlockContent } from "./story-to-date-corpus.js";

export type StoryToDateViewStatus = "ready" | "pending" | "broken";

const MEMORY_JOB_TYPES = new Set<JobType>(["story-to-date", "story-to-date-fold", "archive-name"]);

export interface ActiveMemoryJobView {
  id: string;
  jobType: JobType;
  status: "pending" | "running";
  createdAt: string;
  startedAt: string | null;
  targetSegmentId: string | null;
}

export interface StoryToDateViewEntry {
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
  status: StoryToDateViewStatus;
  tokenCount: number | null;
  jobActive: boolean;
  foldJobActive: boolean;
  nameJobActive: boolean;
}

export interface StoryToDateView {
  segments: StoryToDateViewEntry[];
  activeMemoryJobs: ActiveMemoryJobView[];
  mergedCoverageThroughPost: number | null;
  icPostCount: number;
  total: number;
  withContent: number;
  pending: number;
  broken: number;
}

export function buildStoryToDateView(db: Database.Database, logbookId: string): StoryToDateView {
  const rows = listStoryToDateSegments(db, logbookId, { includeHidden: true, includeBroken: true });
  const segments: StoryToDateViewEntry[] = rows.map((s) => {
    let status: StoryToDateViewStatus = "pending";
    if (s.broken) status = "broken";
    else if (s.content?.trim()) status = "ready";

    const content = s.content?.trim() ? sanitizeStoryBlockContent(s.content.trim()) : null;
    return {
      id: s.id,
      kind: s.kind,
      seq: s.seq,
      createdAt: s.createdAt,
      content,
      name: s.name?.trim() || null,
      coverageThroughIcPost: s.coverageThroughIcPost,
      coveragePageId: s.coveragePageId,
      hidden: s.hidden,
      broken: s.broken,
      status,
      tokenCount: content ? estimateTokens(content) : null,
      jobActive: hasActiveJobForStoryToDate(db, s.id, "story-to-date"),
      foldJobActive: hasActiveJobForStoryToDate(db, s.id, "story-to-date-fold"),
      nameJobActive: hasActiveJobForStoryToDate(db, s.id, "archive-name"),
    };
  });

  const activeMemoryJobs: ActiveMemoryJobView[] = listActiveJobs(db)
    .filter((j) => MEMORY_JOB_TYPES.has(j.jobType))
    .map((j: JobRow) => ({
      id: j.id,
      jobType: j.jobType,
      status: j.status as "pending" | "running",
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      targetSegmentId: j.targetStoryToDateId,
    }));

  segments.sort((a, b) => b.seq - a.seq);

  const ready = segments.filter((s) => s.status === "ready");
  const last = ready.sort((a, b) => b.seq - a.seq)[0];

  return {
    segments,
    activeMemoryJobs,
    mergedCoverageThroughPost: last?.coverageThroughIcPost ?? null,
    icPostCount: countIcPosts(db, logbookId),
    total: segments.length,
    withContent: segments.filter((s) => s.status === "ready").length,
    pending: segments.filter((s) => s.status === "pending").length,
    broken: segments.filter((s) => s.status === "broken").length,
  };
}
