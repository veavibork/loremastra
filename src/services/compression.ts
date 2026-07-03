import type Database from "better-sqlite3";
import { findHeadPageId, getPage } from "../db/page-store.js";
import { getText } from "../db/text-store.js";
import { createJob, hasActiveJobForText } from "../db/job-store.js";
import { getAgentProfile } from "./agent-config.js";
import { postNeedsCompress } from "./content-stamp.js";

/** Doc + lorepebble-proven rule: a post is eligible for compression once it's 5+ positions behind current. */
const COMPRESSION_LAG = 5;

/**
 * Walks back from the head and queues compress jobs for posts past the grace window
 * or stale (stamp/extract mismatch). Walks the full active chain — never stops early
 * at a valid post, since parallel workers can leave gaps deeper in the log.
 */
export function enqueueEligibleCompressJobs(db: Database.Database, userId: string, logbookId: string): void {
  let currentId = findHeadPageId(db, logbookId);
  let position = 0;

  while (currentId) {
    const page = getPage(db, currentId);
    if (!page) break;

    const text = page.selectedTextId ? getText(db, page.selectedTextId) : null;
    const stale = postNeedsCompress(page, text);
    const lagEligible = position >= COMPRESSION_LAG;

    if ((lagEligible || stale) && text?.genPackage) {
      if (stale && !hasActiveJobForText(db, text.id, "compress")) {
        createJob(db, {
          targetTextId: text.id,
          jobType: "compress",
          slotCost: getAgentProfile(userId, "worker").concurrencyCost,
        });
      }
    }

    currentId = page.prevPageId;
    position += 1;
  }
}
