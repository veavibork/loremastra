#!/usr/bin/env node
/**
 * loremaster.md's "MCP Server (Developer-Facing)" section: exposes live
 * application state to AI coding assistants (Cursor, Claude Code, or
 * similar) working on Loremaster itself, so debugging doesn't mean manually
 * copying state out of a running instance into a chat session. This is a
 * development convenience, not a means of opening LM to third-party MCP
 * clients — it reads the same SQLite files the main server does, directly,
 * rather than going through HTTP, since it's meant to run alongside (or
 * instead of) the running dev server.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getGlobalDb } from "../db/global-db.js";
import { getOrCreateDefaultUser } from "../db/user-store.js";
import { listStories } from "../db/story-store.js";
import { getStoryDb, closeStoryDb } from "../db/story-db.js";
import { getStoryState } from "../db/story-state-store.js";
import { getBookByType } from "../db/book-store.js";
import { listWorldbookEntries } from "../db/worldbook-store.js";
import { listTags } from "../db/tag-store.js";
import { listTextIdsForTag } from "../db/tag-index-store.js";
import { listRecentJobs } from "../db/job-store.js";
import { getMaxSlots, getSlotsInUse } from "../queue/slots.js";
import { buildLogView } from "../services/log-view.js";
import { readRecentOutboundRequests } from "../inference/outbound-log.js";
import { ensureSingleInstance } from "./single-instance.js";

ensureSingleInstance();

const server = new McpServer({ name: "loremaster-dev", version: "0.1.0" });

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * This process runs long-lived alongside the dev server purely for one-shot diagnostic reads —
 * unlike the main API server, nothing here benefits from a warm cross-call connection, and
 * getStoryDb() caches its handle indefinitely once opened. Left open, that handle survives in
 * this process even after the main server closes its own and deletes the DB row, which made
 * `DELETE /api/stories/:id` fail with EBUSY on Windows whenever a story had ever been inspected
 * via one of these tools. Closing right after each call keeps this process from accumulating any.
 */
function withStoryDb<T>(storyId: string, fn: (db: Database.Database) => T): T {
  const db = getStoryDb(storyId);
  try {
    return fn(db);
  } finally {
    closeStoryDb(storyId);
  }
}

server.registerTool(
  "list_stories",
  { description: "List all stories with their id, name, and current phase (setup/kickoff/story)." },
  async () => {
    const globalDb = getGlobalDb();
    const user = getOrCreateDefaultUser(globalDb);
    const stories = listStories(globalDb, user.id).map((s) => ({
      id: s.id,
      name: s.name,
      parentStoryId: s.parentStoryId,
      phase: withStoryDb(s.id, (db) => getStoryState(db).phase),
    }));
    return textResult(stories);
  }
);

server.registerTool(
  "get_worldbook",
  {
    description: "Get all worldbook entries for a story, including hidden ones.",
    inputSchema: { storyId: z.string() },
  },
  async ({ storyId }) =>
    withStoryDb(storyId, (db) => {
      const worldbook = getBookByType(db, "worldbook");
      if (!worldbook) return textResult({ error: "no worldbook book for this story" });
      return textResult(listWorldbookEntries(db, worldbook.id, { includeHidden: true }));
    })
);

server.registerTool(
  "get_tags",
  {
    description: "Get the tag cloud for a story, including how many posts each tag currently matches.",
    inputSchema: { storyId: z.string() },
  },
  async ({ storyId }) =>
    withStoryDb(storyId, (db) => {
      const logbook = getBookByType(db, "logbook");
      if (!logbook) return textResult({ error: "no logbook for this story" });
      const tags = listTags(db, getBookByType(db, "game")?.id ?? logbook.id).map((tag) => ({
        ...tag,
        matchedTextCount: listTextIdsForTag(db, tag.id).length,
      }));
      return textResult(tags);
    })
);

server.registerTool(
  "get_queue_status",
  {
    description: "Live queue state for a story: recent jobs (any status) plus global concurrency slot usage.",
    inputSchema: { storyId: z.string() },
  },
  async ({ storyId }) =>
    withStoryDb(storyId, (db) =>
      textResult({
        slots: { used: getSlotsInUse(), max: getMaxSlots() },
        jobs: listRecentJobs(db, 30),
      })
    )
);

server.registerTool(
  "get_recent_log",
  {
    description: "Recent log entries (posts) for a story, oldest first, including hidden ones.",
    inputSchema: { storyId: z.string(), limit: z.number().optional() },
  },
  async ({ storyId, limit }) =>
    withStoryDb(storyId, (db) => {
      const logbook = getBookByType(db, "logbook");
      if (!logbook) return textResult({ error: "no logbook for this story" });
      const entries = buildLogView(db, logbook.id);
      return textResult(limit ? entries.slice(-limit) : entries);
    })
);

server.registerTool(
  "tail_dev_server_log",
  {
    description: "Tail the running dev server's stdout/stderr log (dev-server.log, written by scripts/dev-restart.mjs).",
    inputSchema: { lines: z.number().optional() },
  },
  async ({ lines }) => {
    const logPath = path.resolve(process.cwd(), "dev-server.log");
    if (!existsSync(logPath)) return textResult({ error: `${logPath} does not exist` });
    const content = readFileSync(logPath, "utf-8");
    const allLines = content.split("\n");
    const tail = allLines.slice(-(lines ?? 100)).join("\n");
    return { content: [{ type: "text" as const, text: tail }] };
  }
);

server.registerTool(
  "get_recent_outbound_requests",
  {
    description:
      "Rolling log of the last outbound chat-completions requests sent to Featherless (model + full messages array), across all stories. For troubleshooting prompt-assembly bugs (e.g. guidance/system messages not reaching the model as expected).",
    inputSchema: { limit: z.number().optional() },
  },
  async ({ limit }) => textResult(readRecentOutboundRequests(limit))
);

const transport = new StdioServerTransport();
await server.connect(transport);
