import type Database from "better-sqlite3";
import { getText, type TextRole } from "../db/text-store.js";
import { getArchive, listArchivesForBook, listMemberTextIds, type ArchiveRow } from "../db/archive-store.js";
import { listChronologicalPages } from "../db/page-store.js";
import {
  buildContentBlockForWorker,
  compressPcGuidance,
  resolvePcInSummary,
  resolvePcNameFromContent,
} from "./worldbook-pc.js";

const PRIOR_ARCHIVE_SUMMARIES = 2;

function plainProse(content: string): string {
  return content
    .replace(/<[^>]+>/g, " ")
    .replace(/\{\{\[(?:INPUT|OUTPUT|SYSTEM)\]\}\}/gi, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function roleLabel(role: TextRole): string {
  if (role === "agent") return "assistant";
  if (role === "user") return "user";
  return "system";
}

/** Full prose per archive member — KAI-style, not compressed lines. */
export function buildArchiveProseBlob(db: Database.Database, memberTextIds: string[]): Array<{ role: string; text: string }> {
  const blob: Array<{ role: string; text: string }> = [];
  for (const id of memberTextIds) {
    const text = getText(db, id);
    if (!text?.genPackage?.trim()) continue;
    blob.push({ role: roleLabel(text.role), text: plainProse(text.genPackage) });
  }
  return blob;
}

/** Prior completed archive summaries for continuity (non-overlapping prior blocks only). */
export function buildPriorArchiveContext(db: Database.Database, archive: ArchiveRow): string | null {
  const pages = listChronologicalPages(db, archive.bookId).filter((p) => !p.hidden);
  const positionOf = new Map(pages.map((p, i) => [p.id, i]));
  const startIdx = positionOf.get(archive.startPageId);
  if (startIdx == null) return null;

  const prior = listArchivesForBook(db, archive.bookId)
    .filter((a) => {
      if (a.id === archive.id || !a.summary?.trim() || a.broken) return false;
      const endIdx = positionOf.get(a.endPageId);
      return endIdx != null && endIdx < startIdx;
    })
    .slice(-PRIOR_ARCHIVE_SUMMARIES);

  if (!prior.length) return null;
  return prior.map((a) => a.summary!.trim()).join("\n\n");
}

export function buildArchiveUserPrompt(db: Database.Database, targetArchiveId: string): string {
  const archive = getArchive(db, targetArchiveId);
  if (!archive) throw new Error("target archive no longer exists");

  const memberTextIds = listMemberTextIds(db, targetArchiveId);
  const blob = buildArchiveProseBlob(db, memberTextIds);
  if (!blob.length) throw new Error("no member content to summarize");

  const pcName = resolvePcNameFromContent(db);
  const parts: string[] = [compressPcGuidance(pcName)];

  const content = buildContentBlockForWorker(db);
  if (content) {
    parts.push(`CONTENT (PC identity and setting):\n${content}`);
  }

  const prior = buildPriorArchiveContext(db, archive);
  if (prior) {
    parts.push(`Earlier story summary for continuity:\n${prior}`);
  }

  parts.push(`Messages to archive (full prose only — summarize from these, do not invent events):\n${JSON.stringify(blob, null, 2)}`);
  return parts.join("\n\n");
}

export function finalizeArchiveSummary(db: Database.Database, summary: string): string {
  const pcName = resolvePcNameFromContent(db);
  if (!pcName) return summary;
  return resolvePcInSummary(summary, pcName);
}
