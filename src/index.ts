import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { storiesRoute } from "./routes/stories.js";
import { layoutRoute } from "./routes/layout.js";
import { agentsRoute } from "./routes/agents.js";
import { startPipelineRunner } from "./queue/pipeline-runner.js";
import { WORLDBOOK_FIELD_SCHEMAS } from "./db/worldbook-store.js";
import { getMaxSlots, getSlotsInUse } from "./queue/slots.js";

const app = new Hono();
app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});
app.route("/api/stories", storiesRoute);
app.route("/api/layout", layoutRoute);
app.route("/api/agents", agentsRoute);
app.get("/api/worldbook-schemas", (c) => c.json({ schemas: WORLDBOOK_FIELD_SCHEMAS }));
app.get("/api/debug/slots", (c) => c.json({ used: getSlotsInUse(), max: getMaxSlots() }));

const port = Number(process.env.PORT ?? 4113);

startPipelineRunner();
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Loremaster listening on http://localhost:${info.port}`);
});
