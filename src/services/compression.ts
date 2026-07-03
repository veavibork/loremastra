import type Database from "better-sqlite3";
import { findHeadPageId, getPage } from "../db/page-store.js";
import { getText } from "../db/text-store.js";
import { createJob, hasActiveJobForText } from "../db/job-store.js";
import { getAgentProfile } from "./agent-config.js";

/** Doc + lorepebble-proven rule: a post is eligible for compression once it's 5+ positions behind current. */
const COMPRESSION_LAG = 5;

/**
 * Walks back from the head of the logbook, skipping the grace window, and
 * queues a compress job for anything past it that isn't compressed yet.
 * Stops as soon as it finds a post that's already compressed — everything
 * further back was necessarily handled in an earlier pass.
 */
export function enqueueEligibleCompressJobs(db: Database.Database, userId: string, logbookId: string): void {
  let currentId = findHeadPageId(db, logbookId);
  let position = 0;

  while (currentId) {
    const page = getPage(db, currentId);
    if (!page) break;

    if (position >= COMPRESSION_LAG) {
      const text = page.selectedTextId ? getText(db, page.selectedTextId) : null;
      if (text?.genPackage) {
        if (text.genExtract !== null) break;
        if (!hasActiveJobForText(db, text.id, "compress")) {
          createJob(db, { targetTextId: text.id, jobType: "compress", slotCost: getAgentProfile(userId, "worker").concurrencyCost });
        }
      }
    }

    currentId = page.prevPageId;
    position += 1;
  }
}
