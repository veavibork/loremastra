/**
 * HTTP-layer memory smoke — ephemeral server, no Playwright, no external dev server.
 * DEV_BYPASS must be set before session-guard module loads (dynamic import below).
 */
process.env.DEV_BYPASS_SESSION_GUARD = "true";

import { closeStoryDb } from "../src/db/story-db.js";
import { newId } from "../src/uuid.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok: ${message}`);
}

async function api(
  base: string,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main(): Promise<void> {
  console.log("\n=== ephemeral HTTP API smoke ===\n");

  const { serve } = await import("@hono/node-server");
  const { Hono } = await import("hono");
  const { storiesRoute } = await import("../src/routes/stories.js");
  const { sessionGuard } = await import("../src/middleware/session-guard.js");
  const { startPipelineRunner, stopPipelineRunner } = await import("../src/queue/pipeline-runner.js");

  const app = new Hono();
  app.use("*", sessionGuard);
  app.route("/api/stories", storiesRoute);

  startPipelineRunner();
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("could not bind ephemeral server");
  const base = `http://127.0.0.1:${addr.port}`;

  const created = await api(base, "/api/stories", {
    method: "POST",
    body: JSON.stringify({ name: `http-smoke-${newId().slice(0, 8)}` }),
  });
  assert(created.status === 200, `POST /api/stories creates story (got ${created.status}: ${JSON.stringify(created.body)})`);
  const storyId = (created.body as { story: { id: string } }).story.id;

  try {
    assert(
      (await api(base, `/api/stories/${storyId}/worldbook`, {
        method: "POST",
        body: JSON.stringify({ entryType: "content", content: "Realm of Dragons and knights." }),
      })).status === 200,
      "POST worldbook content"
    );
    assert(
      (await api(base, `/api/stories/${storyId}/worldbook`, {
        method: "POST",
        body: JSON.stringify({ entryType: "roster", content: "Dragon — ancient wyrm guarding the pass." }),
      })).status === 200,
      "POST worldbook roster"
    );

    const kickoff = await api(base, `/api/stories/${storyId}/kickoff`, { method: "POST" });
    assert(kickoff.status === 200, "POST kickoff");
    const kickoffPageId = (kickoff.body as { agentPageId: string }).agentPageId;

    assert(
      (
        await api(base, `/api/stories/${storyId}/posts/${kickoffPageId}/edit`, {
          method: "POST",
          body: JSON.stringify({ content: "The Dragon spread its wings over the valley at dawn." }),
        })
      ).status === 200,
      "POST edit kickoff (no LLM)"
    );

    for (let pair = 0; pair < 4; pair++) {
      assert(
        (
          await api(base, `/api/stories/${storyId}/messages`, {
            method: "POST",
            body: JSON.stringify({ content: `The party asks the Dragon for passage (turn ${pair}).` }),
          })
        ).status === 200,
        `POST messages pair ${pair}`
      );
      const cont = await api(base, `/api/stories/${storyId}/continue`, { method: "POST" });
      assert(cont.status === 200, `POST continue pair ${pair}`);
      const agentPageId = (cont.body as { agentPageId: string }).agentPageId;
      assert(
        (
          await api(base, `/api/stories/${storyId}/posts/${agentPageId}/edit`, {
            method: "POST",
            body: JSON.stringify({ content: `The Dragon rumbles a reply (turn ${pair}).` }),
          })
        ).status === 200,
        `POST edit agent pair ${pair}`
      );
    }

    const preview = await api(base, `/api/stories/${storyId}/prompt-preview`);
    assert(preview.status === 200, "GET prompt-preview");
    assert(JSON.stringify(preview.body).includes("Dragon"), "prompt-preview includes worldbook roster");

    const editMid = await api(base, `/api/stories/${storyId}/posts/${kickoffPageId}/edit`, {
      method: "POST",
      body: JSON.stringify({ content: "EDITED: The Dragon's shadow falls across the camp." }),
    });
    assert(editMid.status === 200, "POST edit triggers invalidation path");

    const undo = await api(base, `/api/stories/${storyId}/position/undo`, { method: "POST" });
    assert(undo.status === 200, "POST undo after edit");

    const phase = await api(base, `/api/stories/${storyId}/phase`);
    assert((phase.body as { phase: string }).phase === "story", "phase is story");

    const memSummary = await api(base, `/api/stories/${storyId}/memory/summary`);
    assert(memSummary.status === 200, "GET memory/summary");
    assert((memSummary.body as { postCount: number }).postCount > 0, "memory summary has posts");

    const backfill = await api(base, `/api/stories/${storyId}/memory/backfill`, {
      method: "POST",
      body: JSON.stringify({ enqueueJobs: false }),
    });
    assert(backfill.status === 200, "POST memory/backfill");

    console.log("\nEphemeral HTTP checks passed.\n");
  } finally {
    await api(base, `/api/stories/${storyId}`, { method: "DELETE" });
    closeStoryDb(storyId);
    server.close();
    stopPipelineRunner();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
