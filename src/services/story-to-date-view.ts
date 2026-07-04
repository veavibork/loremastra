import type Database from "better-sqlite3";
import { hasActiveJobForStoryToDate } from "../db/job-store.js";
import { listStoryToDateSegments } from "../db/story-to-date-store.js";

export interface StoryToDateViewEntry {
  id: string;
  kind: "begins" | "continues";
  seq: number;
  content: string | null;
  coverageThroughIcPost: number | null;
  coveragePageId: string | null;
  hidden: boolean;
  broken: boolean;
  jobActive: boolean;
}

export interface StoryToDateView {
  segments: StoryToDateViewEntry[];
  mergedCoverageThroughPost: number | null;
}

export function buildStoryToDateView(db: Database.Database, logbookId: string): StoryToDateView {
  const segments = listStoryToDateSegments(db, logbookId, { includeHidden: true, includeBroken: true }).map(
    (s) => ({
      id: s.id,
      kind: s.kind,
      seq: s.seq,
      content: s.content,
      coverageThroughIcPost: s.coverageThroughIcPost,
      coveragePageId: s.coveragePageId,
      hidden: s.hidden,
      broken: s.broken,
      jobActive: hasActiveJobForStoryToDate(db, s.id),
    })
  );
  const ready = segments.filter((s) => s.content?.trim() && !s.broken);
  const last = ready.sort((a, b) => b.seq - a.seq)[0];
  return {
    segments,
    mergedCoverageThroughPost: last?.coverageThroughIcPost ?? null,
  };
}
