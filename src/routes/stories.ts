import { unlinkSync } from "node:fs";
import { Hono, type Context, type Next } from "hono";
import { streamSSE } from "hono/streaming";
import { getGlobalDb } from "../db/global-db.js";
import { getStoryDb, closeStoryDb } from "../db/story-db.js";
import type { AppVariables } from "../middleware/session-guard.js";
import { createStory, listStories, getStory, renameStory, deleteStory, DEFAULT_STORY_NAME } from "../db/story-store.js";
import { getStoryStats } from "../services/story-stats.js";
import { createBook, getBookByType, getTagScopeBookId } from "../db/book-store.js";
import { findHeadPageId, collectAncestorIds, listChronologicalPages } from "../db/page-store.js";
import { indexTextAgainstAllTags, reindexTagAcrossBook } from "../services/tag-index.js";
import { enqueueEligibleCompressJobs } from "../services/compression.js";
import { enqueueEligibleArchiveBlocks } from "../services/archive.js";
import { createPageWithText, createRetryText } from "../db/content-store.js";
import { createJob, getJob, listRecentJobs, listActiveJobs, cancelJob } from "../db/job-store.js";
import { getPage, setPageHidden } from "../db/page-store.js";
import { getText } from "../db/text-store.js";
import { createTag, getTag, listTags, renameTag, setTagHidden } from "../db/tag-store.js";
import {
  createWorldbookEntry,
  listWorldbookEntries,
  updateWorldbookEntry,
  setWorldbookEntryHidden,
  type WorldbookEntryType,
} from "../db/worldbook-store.js";
import { getStoryState, setStoryPhase, setKickoffPageId, setCurrentPageId, setOocSessionStartPageId } from "../db/story-state-store.js";
import { recordHistoryEvent, undoHistory, redoHistory, canUndoHistory, canRedoHistory } from "../db/history-store.js";
import { finalizeSetup } from "../services/kickoff.js";
import { forkStory } from "../services/fork.js";
import { onCanonicalTextChangedForStory } from "../services/memory-invalidation.js";
import { trackStoryDb, untrackStoryDb, setJobGuidance, requestJobCancel } from "../queue/pipeline-runner.js";
import { subscribeJob, getJobBuffer, publishCancelled, type JobEvent } from "../queue/job-events.js";
import { buildLogView, buildSummaryPage } from "../services/log-view.js";
import { assembleAuthorPrompt } from "../services/history.js";
import {
  buildMemoryManifest,
  buildMemorySummary,
  enqueueMemoryPipeline,
  previewTagActivation,
  runMemoryBackfill,
} from "../services/memory-manifest.js";
import { EDITOR_SETUP_OPENING } from "../prompts.js";
import { getAgentProfile } from "../services/agent-config.js";

export const storiesRoute = new Hono<{ Variables: AppVariables }>();

storiesRoute.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

/**
 * Every route below the top-level POST/GET "/" operates on a specific story by id — this
 * enforces that the requesting user actually owns it, once for all of them, rather than
 * repeating the check in ~25 individual handlers.
 */
async function requireStoryOwnership(c: Context<{ Variables: AppVariables }>, next: Next): Promise<Response | void> {
  const story = getStory(getGlobalDb(), c.req.param("id")!);
  if (!story) return c.json({ error: "story not found" }, 404);
  if (story.ownerUserId !== c.get("userId")) return c.json({ error: "forbidden" }, 403);
  await next();
}
storiesRoute.use("/:id", requireStoryOwnership);
storiesRoute.use("/:id/*", requireStoryOwnership);

function openTrackedStoryDb(storyId: string) {
  const db = getStoryDb(storyId);
  trackStoryDb(storyId, db);
  return db;
}

storiesRoute.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const name = body.name?.trim() || DEFAULT_STORY_NAME;

  const globalDb = getGlobalDb();
  const story = createStory(globalDb, { ownerUserId: c.get("userId"), name });

  const storyDb = openTrackedStoryDb(story.id);
  const gameBook = createBook(storyDb, { bookType: "game" });
  const logbook = createBook(storyDb, { bookType: "logbook", parentBookId: gameBook.id });
  createBook(storyDb, { bookType: "worldbook", parentBookId: gameBook.id });

  // The Editor "speaks first" — a canned opening line, no inference call, before the user
  // has typed anything. See EDITOR_SETUP_OPENING in src/prompts.ts.
  const { page: openingPage } = createPageWithText(storyDb, {
    bookId: logbook.id,
    role: "agent",
    genPackage: EDITOR_SETUP_OPENING,
  });
  setPageHidden(storyDb, openingPage.id, true);

  return c.json({ story });
});

storiesRoute.get("/", (c) => {
  const globalDb = getGlobalDb();
  const stories = listStories(globalDb, c.get("userId")).map((story) => ({
    ...story,
    stats: getStoryStats(openTrackedStoryDb(story.id)),
  }));
  return c.json({ stories });
});

storiesRoute.patch("/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const globalDb = getGlobalDb();
  const id = c.req.param("id");
  if (!getStory(globalDb, id)) return c.json({ error: "story not found" }, 404);

  if (typeof body.name === "string" && body.name.trim()) {
    renameStory(globalDb, id, body.name.trim());
  }
  return c.json({ story: getStory(globalDb, id) });
});

storiesRoute.delete("/:id", async (c) => {
  const globalDb = getGlobalDb();
  const id = c.req.param("id");
  const story = getStory(globalDb, id);
  if (!story) return c.json({ error: "story not found" }, 404);

  closeStoryDb(id);
  untrackStoryDb(id);
  deleteStory(globalDb, id);

  // The DB row above is the authoritative delete — it already succeeded by this point. WAL mode's
  // -wal/-shm sidecars can stay briefly locked on Windows even after close() returns (checkpoint
  // flush, AV scan, etc.), so a stubborn file is retried a few times and then just logged rather
  // than failing a request whose real work is already done.
  for (const suffix of ["", "-wal", "-shm"]) {
    for (let attempt = 0; ; attempt++) {
      try {
        unlinkSync(story.filePath + suffix);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") break;
        if (code === "EBUSY" && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        console.error(`[stories] failed to delete story file ${story.filePath}${suffix}:`, err);
        break;
      }
    }
  }

  return c.json({ ok: true });
});

storiesRoute.get("/:id/log", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);
  return c.json({ entries: buildLogView(storyDb, logbook.id) });
});

/** Compressed summaries for the Summary tab — paginated, most-recent-first. */
storiesRoute.get("/:id/summaries", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10) || 0);
  const limit = Math.max(1, parseInt(c.req.query("limit") ?? "50", 10) || 50);
  const includeHidden = c.req.query("includeHidden") === "true";

  return c.json(buildSummaryPage(storyDb, logbook.id, { offset, limit, includeHidden }));
});

/**
 * The assembled Author prompt at the current position — read-only, no inference call.
 * Backs Config > Preview (no `tags` query param: real trigger-post tag matches, an
 * accurate "what would the Author see right now") and Lore > Memory (always passes
 * `tags`, even empty: a what-if simulator independent of actual game state, starting
 * from the zero-match baseline).
 */
storiesRoute.get("/:id/prompt-preview", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  const currentPageId = getStoryState(storyDb).currentPageId ?? findHeadPageId(storyDb, logbook.id);
  if (!currentPageId) return c.json({ messages: [] });

  const tagsParam = c.req.query("tags");
  const overrideTagIds = tagsParam !== undefined ? tagsParam.split(",").filter(Boolean) : undefined;

  const messages = assembleAuthorPrompt(storyDb, c.get("userId"), logbook.id, currentPageId, overrideTagIds);
  return c.json({ messages });
});

/** Compact memory health — stale compress counts, archive gaps, no per-post dump. */
storiesRoute.get("/:id/memory/summary", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);
  return c.json(buildMemorySummary(storyDb, logbook.id));
});

/** Full per-post memory manifest (stamps, compress validity, tag counts, archives). */
storiesRoute.get("/:id/memory/manifest", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);
  return c.json(buildMemoryManifest(storyDb, logbook.id));
});

/** KAI-style tag activation preview at current position (or ?fromPageId=). */
storiesRoute.get("/:id/memory/tag-activation", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);
  const fromPageId = c.req.query("fromPageId") ?? undefined;
  return c.json(previewTagActivation(storyDb, logbook.id, fromPageId));
});

/** Repair stamps, optionally reindex tags and enqueue compress/archive jobs. */
storiesRoute.post("/:id/memory/backfill", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { reindexTags?: boolean; enqueueJobs?: boolean };
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);
  return c.json(
    runMemoryBackfill(storyDb, c.get("userId"), logbook.id, {
      reindexTags: body.reindexTags,
      enqueueJobs: body.enqueueJobs,
    })
  );
});

/** Queue eligible compress/archive jobs only — no stamp or tag repair. */
storiesRoute.post("/:id/memory/enqueue", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);
  const pendingMemoryJobs = enqueueMemoryPipeline(storyDb, c.get("userId"), logbook.id);
  return c.json({ pendingMemoryJobs, summary: buildMemorySummary(storyDb, logbook.id) });
});

storiesRoute.get("/:id/phase", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  return c.json(getStoryState(storyDb));
});

storiesRoute.post("/:id/messages", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { content?: string };
  const content = body.content ?? "";
  if (!content.trim()) return c.json({ error: "content is required" }, 400);

  const storyDb = openTrackedStoryDb(c.req.param("id"));
  if (getStoryState(storyDb).phase !== "story") {
    return c.json({ error: "story hasn't reached story phase yet" }, 400);
  }
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  // Attach at the current position (which is the head unless the user has undone/rewound) —
  // submitting new content from an earlier point creates a sibling fork, per loremaster.md's
  // Post Controls: non-destructive, nothing after the current position is touched or lost.
  const attachAt = getStoryState(storyDb).currentPageId ?? findHeadPageId(storyDb, logbook.id);

  const { page: userPage, text: userText } = createPageWithText(storyDb, {
    bookId: logbook.id,
    prevPageId: attachAt,
    role: "user",
    genPackage: content,
  });
  indexTextAgainstAllTags(storyDb, getTagScopeBookId(storyDb, logbook.id), userText.id);

  const { page: agentPage, text: agentText } = createPageWithText(storyDb, {
    bookId: logbook.id,
    prevPageId: userPage.id,
    role: "agent",
  });
  setCurrentPageId(storyDb, null);
  recordHistoryEvent(storyDb, { kind: "page", pageId: agentPage.id, fromValue: attachAt, toValue: agentPage.id });

  const job = createJob(storyDb, {
    targetTextId: agentText.id,
    jobType: "prose",
    slotCost: getAgentProfile(c.get("userId"), "author").concurrencyCost,
    priority: 10,
  });
  enqueueEligibleCompressJobs(storyDb, c.get("userId"), logbook.id);
  enqueueEligibleArchiveBlocks(storyDb, c.get("userId"), logbook.id);

  return c.json({ userPageId: userPage.id, agentPageId: agentPage.id, jobId: job.id });
});

/**
 * Regenerate an existing agent post in place — a new text version on the same page, per
 * loremaster.md's Retry / Guided retry. Works on any agent page regardless of phase (the
 * setup conversation and story posts share the same logbook), but which *job type* to queue
 * depends on what kind of page it is: an OOC/setup page needs the Editor's tool-calling turn
 * (executeSetupJob), not a plain prose continuation — retrying it as "prose" would run it
 * through the Author's core prompt instead of the setup flow entirely. Every OOC/setup page is
 * hidden the moment it's created (see POST /:id/setup/messages) and no other page ever is, so
 * page.hidden is a direct, phase-independent answer — including for a page created by a resumed
 * post-kickoff OOC conversation, which isn't an ancestor of kickoffPageId the way a pre-kickoff
 * setup page is.
 */
storiesRoute.post("/:id/posts/:pageId/retry", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { guidance?: string };
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const pageId = c.req.param("pageId");

  const page = getPage(storyDb, pageId);
  if (!page) return c.json({ error: "page not found" }, 404);
  if (!page.selectedTextId) return c.json({ error: "page has no current text" }, 400);
  const currentText = getText(storyDb, page.selectedTextId);
  if (!currentText) return c.json({ error: "current text not found" }, 404);
  if (currentText.role !== "agent") return c.json({ error: "only agent posts can be retried" }, 400);

  const isSetupPage = page.hidden;

  const newText = createRetryText(storyDb, {
    pageId,
    priorTextId: currentText.id,
    role: "agent",
  });
  recordHistoryEvent(storyDb, { kind: "text", pageId, fromValue: currentText.id, toValue: newText.id });
  onCanonicalTextChangedForStory(storyDb, c.get("userId"), pageId);
  const job = createJob(storyDb, {
    targetTextId: newText.id,
    jobType: isSetupPage ? "setup" : "prose",
    slotCost: getAgentProfile(c.get("userId"), isSetupPage ? "editor" : "author").concurrencyCost,
    priority: 10,
  });
  if (body.guidance?.trim()) setJobGuidance(job.id, body.guidance.trim(), "regenerate");

  return c.json({ jobId: job.id, pageId, textId: newText.id });
});

/** Directly overwrite a post's content — a new text version with user-supplied text, no inference call. Re-indexed against tags immediately. */
storiesRoute.post("/:id/posts/:pageId/edit", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { content?: string };
  const content = body.content ?? "";
  if (!content.trim()) return c.json({ error: "content is required" }, 400);

  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const pageId = c.req.param("pageId");

  const page = getPage(storyDb, pageId);
  if (!page) return c.json({ error: "page not found" }, 404);
  if (!page.selectedTextId) return c.json({ error: "page has no current text" }, 400);
  const currentText = getText(storyDb, page.selectedTextId);
  if (!currentText) return c.json({ error: "current text not found" }, 404);

  const newText = createRetryText(storyDb, {
    pageId,
    priorTextId: currentText.id,
    role: currentText.role,
    genPackage: content,
  });
  recordHistoryEvent(storyDb, { kind: "text", pageId, fromValue: currentText.id, toValue: newText.id });
  onCanonicalTextChangedForStory(storyDb, c.get("userId"), pageId);

  return c.json({ ok: true, textId: newText.id });
});

/**
 * Generate a continuation from the current position (or the head, if nothing's been rewound) —
 * a new agent page, not appended to the existing one. Whether this is an Editor (OOC) or Author
 * (IC) continuation isn't decided by phase alone: post-kickoff, the current position can be a
 * resumed OOC conversation's hidden page just as easily as an in-character one, since both share
 * the same page chain. Checking the attach point's own hidden flag (same invariant as retry, see
 * POST /:id/posts/:pageId/retry) gets this right in both cases.
 */
storiesRoute.post("/:id/continue", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { guidance?: string };
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const phase = getStoryState(storyDb).phase;
  if (phase !== "setup" && phase !== "story") {
    return c.json({ error: "story isn't in a phase that can continue" }, 400);
  }
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  const attachAt = getStoryState(storyDb).currentPageId ?? findHeadPageId(storyDb, logbook.id);
  const isSetupContinuation = phase === "setup" || !!(attachAt && getPage(storyDb, attachAt)?.hidden);

  const { page, text } = createPageWithText(storyDb, { bookId: logbook.id, prevPageId: attachAt, role: "agent" });
  if (isSetupContinuation) setPageHidden(storyDb, page.id, true);
  setCurrentPageId(storyDb, null);
  recordHistoryEvent(storyDb, { kind: "page", pageId: page.id, fromValue: attachAt, toValue: page.id });

  const job = createJob(storyDb, {
    targetTextId: text.id,
    jobType: isSetupContinuation ? "setup" : "prose",
    slotCost: getAgentProfile(c.get("userId"), isSetupContinuation ? "editor" : "author").concurrencyCost,
    priority: 10,
  });
  if (body.guidance?.trim()) setJobGuidance(job.id, body.guidance.trim(), "continue");

  return c.json({ agentPageId: page.id, jobId: job.id });
});

function currentPositionResponse(storyDb: ReturnType<typeof getStoryDb>) {
  const logbook = getBookByType(storyDb, "logbook");
  const headPageId = logbook ? findHeadPageId(storyDb, logbook.id) : null;
  const currentPageId = getStoryState(storyDb).currentPageId ?? headPageId;
  return {
    currentPageId,
    headPageId,
    atHead: currentPageId === headPageId,
    canUndo: canUndoHistory(storyDb),
    canRedo: canRedoHistory(storyDb),
  };
}

/** Where the "cursor" is right now — the head unless Undo/Redo/Rewind has moved it. See loremaster.md's Post Controls: Undo/Redo. */
storiesRoute.get("/:id/position", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);
  return c.json(currentPositionResponse(storyDb));
});

/** Reverses whatever happened most recently on the unified history ledger — navigation, retry, or edit. See history-store.ts. */
storiesRoute.post("/:id/position/undo", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const result = undoHistory(storyDb);
  if (!result) return c.json({ error: "already at the beginning" }, 400);
  if (result.canonicalTextPageId) {
    onCanonicalTextChangedForStory(storyDb, c.get("userId"), result.canonicalTextPageId);
  }
  return c.json(currentPositionResponse(storyDb));
});

storiesRoute.post("/:id/position/redo", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const result = redoHistory(storyDb);
  if (!result) return c.json({ error: "nothing to redo" }, 400);
  if (result.canonicalTextPageId) {
    onCanonicalTextChangedForStory(storyDb, c.get("userId"), result.canonicalTextPageId);
  }
  return c.json(currentPositionResponse(storyDb));
});

/** Rewind directly to any page in the current head's history (not just one step) — same underlying cursor as Undo/Redo, just a bigger jump. */
storiesRoute.post("/:id/position", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { pageId?: string };
  if (!body.pageId) return c.json({ error: "pageId is required" }, 400);

  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  const headPageId = findHeadPageId(storyDb, logbook.id);
  if (!headPageId) return c.json({ error: "story has no posts yet" }, 400);

  const ancestry = collectAncestorIds(storyDb, headPageId);
  if (!ancestry.has(body.pageId)) {
    return c.json({ error: "that page isn't part of the current story's history" }, 400);
  }

  const fromPageId = getStoryState(storyDb).currentPageId ?? headPageId;
  setCurrentPageId(storyDb, body.pageId === headPageId ? null : body.pageId);
  recordHistoryEvent(storyDb, { kind: "page", pageId: body.pageId, fromValue: fromPageId, toValue: body.pageId });
  return c.json(currentPositionResponse(storyDb));
});

/** Genuinely new save slot — a full copy of the story file, truncated after the fork point. */
storiesRoute.post("/:id/fork", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { pageId?: string; name?: string };
  const sourceStoryId = c.req.param("id");
  const storyDb = openTrackedStoryDb(sourceStoryId);

  if (getStoryState(storyDb).phase !== "story") {
    return c.json({ error: "can only fork once the story phase has started" }, 400);
  }

  const globalDb = getGlobalDb();
  const sourceStory = getStory(globalDb, sourceStoryId);
  if (!sourceStory) return c.json({ error: "source story not found" }, 404);

  try {
    const newStory = forkStory(globalDb, storyDb, {
      ownerUserId: c.get("userId"),
      sourceStoryId,
      sourceName: sourceStory.name,
      name: body.name,
      forkPageId: body.pageId ?? null,
    });
    openTrackedStoryDb(newStory.id);
    return c.json({ story: newStory });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * OOC/setup conversation — usable both before the initial kickoff and any time after (the Story
 * tab's OOC toggle isn't phase-gated, see web/src/StoryView.tsx), e.g. to revise the worldbook
 * without touching the in-character story. Both pages are hidden immediately: it's what lets
 * these turns share the logbook's single page chain with in-character content (advancing the same
 * "head" as everything else) without ever being seen by the Author or shown in Play/IC mode — and
 * what lets buildSetupConversation (pipeline-runner.ts) find just this conversation's own history
 * later, even with a whole IC story now interleaved in between.
 */
storiesRoute.post("/:id/setup/messages", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { content?: string };
  const content = body.content ?? "";
  if (!content.trim()) return c.json({ error: "content is required" }, 400);

  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  const attachAt = getStoryState(storyDb).currentPageId ?? findHeadPageId(storyDb, logbook.id);
  const { page: userPage, text: userText } = createPageWithText(storyDb, {
    bookId: logbook.id,
    prevPageId: attachAt,
    role: "user",
    genPackage: content,
  });
  setPageHidden(storyDb, userPage.id, true);
  indexTextAgainstAllTags(storyDb, getTagScopeBookId(storyDb, logbook.id), userText.id);

  const { page: agentPage, text: agentText } = createPageWithText(storyDb, {
    bookId: logbook.id,
    prevPageId: userPage.id,
    role: "agent",
  });
  setPageHidden(storyDb, agentPage.id, true);
  setCurrentPageId(storyDb, null);
  recordHistoryEvent(storyDb, { kind: "page", pageId: agentPage.id, fromValue: attachAt, toValue: agentPage.id });

  const job = createJob(storyDb, {
    targetTextId: agentText.id,
    jobType: "setup",
    slotCost: getAgentProfile(c.get("userId"), "editor").concurrencyCost,
    priority: 10,
  });
  return c.json({ userPageId: userPage.id, agentPageId: agentPage.id, jobId: job.id });
});

/**
 * One-shot kickoff: generates the opening post and immediately moves the story into story
 * phase — no separate review/approve step. If the result isn't right, the normal
 * Retry/Guided Retry on this page (via /posts/:pageId/retry) regenerates it; pipeline-runner
 * keys the worldbook-only kickoff prompt off kickoffPageId identity, not current phase, so
 * that keeps working correctly after this point.
 */
storiesRoute.post("/:id/kickoff", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  if (getStoryState(storyDb).phase !== "setup") return c.json({ error: "story is not in setup phase" }, 400);

  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  const attachAt = getStoryState(storyDb).currentPageId ?? findHeadPageId(storyDb, logbook.id);
  const { page, text } = createPageWithText(storyDb, { bookId: logbook.id, prevPageId: attachAt, role: "agent" });

  setKickoffPageId(storyDb, page.id);
  finalizeSetup(storyDb, logbook.id, page.id);
  setStoryPhase(storyDb, "story");
  setCurrentPageId(storyDb, null);
  recordHistoryEvent(storyDb, { kind: "page", pageId: page.id, fromValue: attachAt, toValue: page.id });

  const job = createJob(storyDb, {
    targetTextId: text.id,
    jobType: "prose",
    slotCost: getAgentProfile(c.get("userId"), "author").concurrencyCost,
    priority: 10,
  });
  return c.json({ agentPageId: page.id, jobId: job.id });
});

/**
 * Marks a fresh post-kickoff OOC "update session" boundary — every Play→OOC switch after
 * kickoff calls this. No page is created and nothing is added to the log (a canned opener
 * used to be dropped here, but it showed up as a visible chat line and stacked up if someone
 * flipped Play/OOC repeatedly). The boundary is just the most recent existing hidden page, so
 * the Editor's context still resets to this session's turns (plus read-only IC awareness)
 * instead of replaying every OOC turn the story has ever had — silently, with nothing new to
 * see in the log. Pre-kickoff setup doesn't need this — it's already in OOC mode by default
 * from story creation's own canned opener.
 */
storiesRoute.post("/:id/ooc/start-session", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  if (getStoryState(storyDb).phase !== "story") return c.json({ error: "story hasn't reached story phase yet" }, 400);

  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  const hiddenPages = listChronologicalPages(storyDb, logbook.id).filter((p) => p.hidden);
  const boundaryPageId = hiddenPages.length > 0 ? hiddenPages[hiddenPages.length - 1].id : null;
  setOocSessionStartPageId(storyDb, boundaryPageId);

  return c.json({ ok: true });
});

storiesRoute.get("/:id/tags", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);
  return c.json({ tags: listTags(storyDb, getTagScopeBookId(storyDb, logbook.id)) });
});

storiesRoute.post("/:id/tags", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const name = body.name ?? "";

  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  try {
    const tag = createTag(storyDb, { bookId: getTagScopeBookId(storyDb, logbook.id), name });
    reindexTagAcrossBook(storyDb, tag.id);
    return c.json({ tag: getTag(storyDb, tag.id) ?? tag });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

storiesRoute.patch("/:id/tags/:tagId", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; hidden?: boolean };
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const tagId = c.req.param("tagId");

  try {
    if (typeof body.name === "string") {
      const tag = renameTag(storyDb, tagId, body.name);
      reindexTagAcrossBook(storyDb, tag.id);
    }
    if (typeof body.hidden === "boolean") {
      setTagHidden(storyDb, tagId, body.hidden);
    }
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

storiesRoute.get("/:id/worldbook", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const worldbook = getBookByType(storyDb, "worldbook");
  if (!worldbook) return c.json({ error: "worldbook not found" }, 404);
  return c.json({ entries: listWorldbookEntries(storyDb, worldbook.id, { includeHidden: true }) });
});

storiesRoute.post("/:id/worldbook", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { entryType?: WorldbookEntryType; content?: string };
  if (!body.entryType || !body.content?.trim()) return c.json({ error: "entryType and content are required" }, 400);

  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const worldbook = getBookByType(storyDb, "worldbook");
  if (!worldbook) return c.json({ error: "worldbook not found" }, 404);

  try {
    const entry = createWorldbookEntry(storyDb, { bookId: worldbook.id, entryType: body.entryType, content: body.content });
    indexTextAgainstAllTags(storyDb, getTagScopeBookId(storyDb, worldbook.id), entry.currentTextId);
    return c.json({ entry });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

storiesRoute.patch("/:id/worldbook/:pageId", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { content?: string; hidden?: boolean };
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const pageId = c.req.param("pageId");

  try {
    if (typeof body.hidden === "boolean") setWorldbookEntryHidden(storyDb, pageId, body.hidden);
    if (typeof body.content === "string") {
      const entry = updateWorldbookEntry(storyDb, pageId, { content: body.content });
      indexTextAgainstAllTags(storyDb, getTagScopeBookId(storyDb, entry.bookId), entry.currentTextId);
    }
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

storiesRoute.get("/:id/jobs", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  return c.json({ jobs: listRecentJobs(storyDb) });
});

/**
 * Jobs still in flight for this story — lets a freshly (re)mounted client find a generation
 * it isn't already watching (e.g. after closing and reopening the story tab) and reattach to
 * its stream. Registered before the `:jobId` route below so "active" isn't swallowed as an id.
 */
storiesRoute.get("/:id/jobs/active", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  return c.json({ jobs: listActiveJobs(storyDb) });
});

storiesRoute.get("/:id/jobs/:jobId", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const job = getJob(storyDb, c.req.param("jobId"));
  if (!job) return c.json({ error: "job not found" }, 404);
  return c.json({ job });
});

/**
 * Pending jobs (not yet claimed) have no in-flight call to abort — mark cancelled directly.
 * Running jobs are aborted via requestJobCancel; the executor's own catch/finally in
 * pipeline-runner.ts does the actual DB update, publishCancelled, and slot release once the
 * abort propagates, so this route doesn't race it by also writing the cancelled status itself.
 */
storiesRoute.post("/:id/jobs/:jobId/cancel", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const jobId = c.req.param("jobId");
  const job = getJob(storyDb, jobId);
  if (!job) return c.json({ error: "job not found" }, 404);
  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
    return c.json({ job });
  }
  if (job.status === "pending") {
    cancelJob(storyDb, jobId);
    publishCancelled(jobId);
    return c.json({ ok: true });
  }
  const aborted = requestJobCancel(jobId);
  if (!aborted) {
    // Running but has no controller — a job type that doesn't support mid-flight cancel yet
    // (compress/archive, and now Horde too — see requestJobCancel's comment). Nothing to do
    // but say so; it'll resolve on its own soon either way.
    return c.json({ error: "this job type can't be cancelled mid-generation" }, 409);
  }
  return c.json({ ok: true });
});

/**
 * Subscribes to the job's event bus BEFORE checking its current status.
 * Both operations are synchronous with no await between them, so on Node's
 * single-threaded event loop the job cannot transition states in the gap —
 * this is what avoids the "connection opened, nothing ever arrives" failure
 * mode we found in lorepebble's queue.
 */
storiesRoute.get("/:id/jobs/:jobId/stream", (c) => {
  const storyId = c.req.param("id");
  const jobId = c.req.param("jobId");
  const storyDb = openTrackedStoryDb(storyId);

  return streamSSE(c, async (sse) => {
    let settled = false;
    const finish = async (event: JobEvent | { type: "error"; message: string }) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      await sse.writeSSE({ data: JSON.stringify(event) });
      await sse.writeSSE({ data: "[DONE]" });
    };

    // Long generations can sit silent between tokens for a while; an idle connection with no
    // bytes flowing is what an idle-socket timeout (browser/OS/AV) can kill without either side
    // seeing an "error" worth reacting to. A raw SSE comment line (ignored by EventSource's
    // onmessage) keeps the socket demonstrably alive without changing the event contract.
    const heartbeat = setInterval(() => {
      void sse.write(": ping\n\n");
    }, 15000);

    await new Promise<void>((resolve) => {
      const unsubscribe = subscribeJob(jobId, (event) => {
        if (event.type === "token" || event.type === "progress") {
          void sse.writeSSE({ data: JSON.stringify(event) });
          return;
        }
        unsubscribe();
        void finish(event).then(resolve);
      });

      const job = getJob(storyDb, jobId);
      if (!job) {
        unsubscribe();
        void finish({ type: "error", message: "job not found" }).then(resolve);
        return;
      }
      if (job.status === "cancelled") {
        unsubscribe();
        void finish({ type: "cancelled" }).then(resolve);
        return;
      }
      if (job.status === "done" || job.status === "failed") {
        unsubscribe();
        const text = job.targetTextId ? getText(storyDb, job.targetTextId) : null;
        void finish({ type: "done", fullText: text?.genPackage ?? "" }).then(resolve);
        return;
      }
      // Still pending/running: replay whatever's accumulated so far (a reconnecting client —
      // e.g. the story tab was closed and reopened mid-generation — sees the post at its
      // current stage instead of nothing until it lands). Safe against the subscribe-then-read
      // race above: no await happened between subscribeJob and this read, so nothing else could
      // have run on Node's single thread to add tokens the buffer read would miss.
      const buffered = getJobBuffer(jobId);
      if (buffered && (buffered.text || buffered.progress)) {
        void sse.writeSSE({ data: JSON.stringify({ type: "sync", text: buffered.text, progress: buffered.progress }) });
      }
    });
  });
});
