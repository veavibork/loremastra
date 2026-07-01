import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getGlobalDb } from "../db/global-db.js";
import { getStoryDb } from "../db/story-db.js";
import { getOrCreateDefaultUser } from "../db/user-store.js";
import { createStory, listStories, getStory, renameStory } from "../db/story-store.js";
import { createBook, getBookByType, getTagScopeBookId } from "../db/book-store.js";
import { findHeadPageId, collectAncestorIds } from "../db/page-store.js";
import { indexTextAgainstAllTags, reindexTagAcrossBook } from "../services/tag-index.js";
import { enqueueEligibleCompressJobs } from "../services/compression.js";
import { enqueueEligibleArchiveBlocks } from "../services/archive.js";
import { createPageWithText, createRetryText } from "../db/content-store.js";
import { createJob, getJob, listRecentJobs } from "../db/job-store.js";
import { getPage } from "../db/page-store.js";
import { getText } from "../db/text-store.js";
import { createTag, listTags, renameTag, setTagHidden, setTagWorldbookPage } from "../db/tag-store.js";
import {
  createWorldbookEntry,
  listWorldbookEntries,
  updateWorldbookEntry,
  setWorldbookEntryHidden,
  type WorldbookEntryType,
} from "../db/worldbook-store.js";
import { getStoryState, setStoryPhase, setKickoffPageId, setCurrentPageId } from "../db/story-state-store.js";
import { finalizeSetup } from "../services/kickoff.js";
import { forkStory } from "../services/fork.js";
import { trackStoryDb, setJobGuidance } from "../queue/pipeline-runner.js";
import { subscribeJob, type JobEvent } from "../queue/job-events.js";
import { buildLogView } from "../services/log-view.js";
import { assembleAuthorPrompt } from "../services/history.js";

export const storiesRoute = new Hono();

storiesRoute.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

function openTrackedStoryDb(storyId: string) {
  const db = getStoryDb(storyId);
  trackStoryDb(storyId, db);
  return db;
}

storiesRoute.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const name = body.name?.trim() || "Untitled Story";

  const globalDb = getGlobalDb();
  const user = getOrCreateDefaultUser(globalDb);
  const story = createStory(globalDb, { ownerUserId: user.id, name });

  const storyDb = openTrackedStoryDb(story.id);
  const gameBook = createBook(storyDb, { bookType: "game" });
  createBook(storyDb, { bookType: "logbook", parentBookId: gameBook.id });
  createBook(storyDb, { bookType: "worldbook", parentBookId: gameBook.id });

  return c.json({ story });
});

storiesRoute.get("/", (c) => {
  const globalDb = getGlobalDb();
  const user = getOrCreateDefaultUser(globalDb);
  return c.json({ stories: listStories(globalDb, user.id) });
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

storiesRoute.get("/:id/log", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);
  return c.json({ entries: buildLogView(storyDb, logbook.id) });
});

/** The assembled Author prompt as it stands right now (at the current position) — read-only, no inference call. Backs both Lore > Memory and Config > Preview, which are the same underlying view in different contexts (doc: in-play vs. outside-play). */
storiesRoute.get("/:id/prompt-preview", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  const currentPageId = getStoryState(storyDb).currentPageId ?? findHeadPageId(storyDb, logbook.id);
  if (!currentPageId) return c.json({ messages: [] });

  const messages = assembleAuthorPrompt(storyDb, logbook.id, currentPageId);
  return c.json({ messages });
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

  const job = createJob(storyDb, { targetTextId: agentText.id, jobType: "prose", slotCost: 4, priority: 10 });
  enqueueEligibleCompressJobs(storyDb, logbook.id);
  enqueueEligibleArchiveBlocks(storyDb, logbook.id);

  return c.json({ userPageId: userPage.id, agentPageId: agentPage.id, jobId: job.id });
});

/** Regenerate an existing agent post in place — a new text version on the same page, per loremaster.md's Retry / Guided retry. */
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

  const newText = createRetryText(storyDb, {
    pageId,
    priorTextId: currentText.id,
    role: "agent",
  });
  const job = createJob(storyDb, { targetTextId: newText.id, jobType: "prose", slotCost: 4, priority: 10 });
  if (body.guidance?.trim()) setJobGuidance(job.id, body.guidance.trim());

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
  indexTextAgainstAllTags(storyDb, getTagScopeBookId(storyDb, page.bookId), newText.id);

  return c.json({ ok: true, textId: newText.id });
});

/** Generate a continuation from the current position (or the head, if nothing's been rewound) — a new agent page, not appended to the existing one. */
storiesRoute.post("/:id/continue", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { guidance?: string };
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  if (getStoryState(storyDb).phase !== "story") {
    return c.json({ error: "story hasn't reached story phase yet" }, 400);
  }
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  const attachAt = getStoryState(storyDb).currentPageId ?? findHeadPageId(storyDb, logbook.id);
  const { page, text } = createPageWithText(storyDb, { bookId: logbook.id, prevPageId: attachAt, role: "agent" });
  setCurrentPageId(storyDb, null);

  const job = createJob(storyDb, { targetTextId: text.id, jobType: "prose", slotCost: 4, priority: 10 });
  if (body.guidance?.trim()) setJobGuidance(job.id, body.guidance.trim());

  return c.json({ agentPageId: page.id, jobId: job.id });
});

/** Where the "cursor" is right now — the head unless Undo/Redo/Rewind has moved it. See loremaster.md's Post Controls: Undo/Redo. */
storiesRoute.get("/:id/position", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  const headPageId = findHeadPageId(storyDb, logbook.id);
  const currentPageId = getStoryState(storyDb).currentPageId ?? headPageId;
  return c.json({ currentPageId, headPageId, atHead: currentPageId === headPageId });
});

storiesRoute.post("/:id/position/undo", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  const headPageId = findHeadPageId(storyDb, logbook.id);
  const currentPageId = getStoryState(storyDb).currentPageId ?? headPageId;
  const current = currentPageId ? getPage(storyDb, currentPageId) : null;
  if (!current?.prevPageId) return c.json({ error: "already at the beginning" }, 400);

  setCurrentPageId(storyDb, current.prevPageId);
  return c.json({ currentPageId: current.prevPageId });
});

storiesRoute.post("/:id/position/redo", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  const headPageId = findHeadPageId(storyDb, logbook.id);
  const currentPageId = getStoryState(storyDb).currentPageId ?? headPageId;
  const current = currentPageId ? getPage(storyDb, currentPageId) : null;
  if (!current?.selectedForkPageId) return c.json({ error: "nothing to redo" }, 400);

  const target = current.selectedForkPageId;
  setCurrentPageId(storyDb, target === headPageId ? null : target);
  return c.json({ currentPageId: target });
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

  setCurrentPageId(storyDb, body.pageId === headPageId ? null : body.pageId);
  return c.json({ currentPageId: body.pageId });
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
  const user = getOrCreateDefaultUser(globalDb);
  const sourceStory = getStory(globalDb, sourceStoryId);
  if (!sourceStory) return c.json({ error: "source story not found" }, 404);

  try {
    const newStory = forkStory(globalDb, storyDb, {
      ownerUserId: user.id,
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

storiesRoute.post("/:id/setup/messages", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { content?: string };
  const content = body.content ?? "";
  if (!content.trim()) return c.json({ error: "content is required" }, 400);

  const storyDb = openTrackedStoryDb(c.req.param("id"));
  if (getStoryState(storyDb).phase !== "setup") {
    return c.json({ error: "story is not in setup phase" }, 400);
  }
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  const headPageId = findHeadPageId(storyDb, logbook.id);
  const { page: userPage, text: userText } = createPageWithText(storyDb, {
    bookId: logbook.id,
    prevPageId: headPageId,
    role: "user",
    genPackage: content,
  });
  indexTextAgainstAllTags(storyDb, getTagScopeBookId(storyDb, logbook.id), userText.id);

  const { page: agentPage, text: agentText } = createPageWithText(storyDb, {
    bookId: logbook.id,
    prevPageId: userPage.id,
    role: "agent",
  });

  const job = createJob(storyDb, { targetTextId: agentText.id, jobType: "setup", slotCost: 4, priority: 10 });
  return c.json({ userPageId: userPage.id, agentPageId: agentPage.id, jobId: job.id });
});

storiesRoute.post("/:id/kickoff/start", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const state = getStoryState(storyDb);
  if (state.phase !== "setup") return c.json({ error: "story is not in setup phase" }, 400);

  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  // Reuse the same page across kickoff attempts (e.g. after Back to Setup) via
  // createRetryText — a new version, not a new log entry each time.
  let pageId: string;
  let textId: string;
  if (state.kickoffPageId) {
    const page = getPage(storyDb, state.kickoffPageId);
    if (!page?.selectedTextId) return c.json({ error: "kickoff page is missing its current text" }, 500);
    const text = createRetryText(storyDb, { pageId: page.id, priorTextId: page.selectedTextId, role: "agent" });
    pageId = page.id;
    textId = text.id;
  } else {
    const headPageId = findHeadPageId(storyDb, logbook.id);
    const { page, text } = createPageWithText(storyDb, { bookId: logbook.id, prevPageId: headPageId, role: "agent" });
    pageId = page.id;
    textId = text.id;
    setKickoffPageId(storyDb, page.id);
  }

  setStoryPhase(storyDb, "kickoff");
  const job = createJob(storyDb, { targetTextId: textId, jobType: "prose", slotCost: 4, priority: 10 });
  return c.json({ jobId: job.id, kickoffPageId: pageId });
});

storiesRoute.post("/:id/kickoff/retry", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { guidance?: string };
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const state = getStoryState(storyDb);
  if (state.phase !== "kickoff" || !state.kickoffPageId) {
    return c.json({ error: "story is not in kickoff phase" }, 400);
  }

  const page = getPage(storyDb, state.kickoffPageId);
  if (!page?.selectedTextId) return c.json({ error: "kickoff page is missing its current text" }, 500);

  const text = createRetryText(storyDb, { pageId: page.id, priorTextId: page.selectedTextId, role: "agent" });
  const job = createJob(storyDb, { targetTextId: text.id, jobType: "prose", slotCost: 4, priority: 10 });
  if (body.guidance?.trim()) setJobGuidance(job.id, body.guidance.trim());

  return c.json({ jobId: job.id, kickoffPageId: page.id });
});

storiesRoute.post("/:id/kickoff/back", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  if (getStoryState(storyDb).phase !== "kickoff") {
    return c.json({ error: "story is not in kickoff phase" }, 400);
  }
  setStoryPhase(storyDb, "setup");
  return c.json({ ok: true });
});

storiesRoute.post("/:id/kickoff/approve", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const state = getStoryState(storyDb);
  if (state.phase !== "kickoff" || !state.kickoffPageId) {
    return c.json({ error: "story is not in kickoff phase" }, 400);
  }
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  finalizeSetup(storyDb, logbook.id, state.kickoffPageId);
  setStoryPhase(storyDb, "story");
  return c.json({ ok: true });
});

storiesRoute.get("/:id/tags", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);
  return c.json({ tags: listTags(storyDb, getTagScopeBookId(storyDb, logbook.id)) });
});

storiesRoute.post("/:id/tags", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; worldbookPageId?: string | null };
  const name = body.name ?? "";

  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const logbook = getBookByType(storyDb, "logbook");
  if (!logbook) return c.json({ error: "logbook not found" }, 404);

  try {
    const tag = createTag(storyDb, {
      bookId: getTagScopeBookId(storyDb, logbook.id),
      name,
      worldbookPageId: body.worldbookPageId ?? null,
    });
    reindexTagAcrossBook(storyDb, tag.id);
    return c.json({ tag });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

storiesRoute.patch("/:id/tags/:tagId", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    hidden?: boolean;
    worldbookPageId?: string | null;
  };
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
    if ("worldbookPageId" in body) {
      setTagWorldbookPage(storyDb, tagId, body.worldbookPageId ?? null);
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
  const body = (await c.req.json().catch(() => ({}))) as {
    entryType?: WorldbookEntryType;
    isPc?: boolean;
    name?: string;
    fields?: Record<string, string>;
  };
  if (!body.entryType || !body.name) return c.json({ error: "entryType and name are required" }, 400);

  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const worldbook = getBookByType(storyDb, "worldbook");
  if (!worldbook) return c.json({ error: "worldbook not found" }, 404);

  try {
    const entry = createWorldbookEntry(storyDb, {
      bookId: worldbook.id,
      entryType: body.entryType,
      isPc: body.isPc ?? false,
      name: body.name,
      fields: body.fields ?? {},
    });
    return c.json({ entry });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

storiesRoute.patch("/:id/worldbook/:pageId", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    fields?: Record<string, string>;
    hidden?: boolean;
  };
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const pageId = c.req.param("pageId");

  try {
    if (typeof body.hidden === "boolean") setWorldbookEntryHidden(storyDb, pageId, body.hidden);
    if (typeof body.name === "string" || body.fields) {
      updateWorldbookEntry(storyDb, pageId, { name: body.name, fields: body.fields });
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

storiesRoute.get("/:id/jobs/:jobId", (c) => {
  const storyDb = openTrackedStoryDb(c.req.param("id"));
  const job = getJob(storyDb, c.req.param("jobId"));
  if (!job) return c.json({ error: "job not found" }, 404);
  return c.json({ job });
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
      await sse.writeSSE({ data: JSON.stringify(event) });
      await sse.writeSSE({ data: "[DONE]" });
    };

    await new Promise<void>((resolve) => {
      const unsubscribe = subscribeJob(jobId, (event) => {
        if (event.type === "token") {
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
      if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
        unsubscribe();
        const text = job.targetTextId ? getText(storyDb, job.targetTextId) : null;
        void finish({ type: "done", fullText: text?.genPackage ?? "" }).then(resolve);
      }
    });
  });
});
