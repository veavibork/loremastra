import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { storiesRoute } from "./routes/stories.js";
import { layoutRoute } from "./routes/layout.js";
import { agentsRoute } from "./routes/agents.js";
import { promptsRoute } from "./routes/prompts.js";
import { settingsSpacesRoute } from "./routes/settings-spaces.js";
import { clientErrorsRoute } from "./routes/client-errors.js";
import { sessionsRoute } from "./routes/sessions.js";
import { sessionGuard } from "./middleware/session-guard.js";
import { startPipelineRunner } from "./queue/pipeline-runner.js";
import { getMaxSlots, getSlotsInUse } from "./queue/slots.js";

const app = new Hono();
// The only middleware that actually answers a browser's CORS preflight: it short-circuits
// OPTIONS before dispatch reaches any sub-route's own "*" middleware (app.route() delegates
// to those only for non-preflight handling), so their per-route Allow-Methods headers are
// dead code for OPTIONS specifically. This one has to list every method any route uses.
app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, X-Loremaster-Session, X-Loremaster-Interaction");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});
// Single-active-session enforcement (src/middleware/session-guard.ts) — must run after the
// CORS middleware above (so OPTIONS preflight is never blocked) and before every route,
// including the two inline ones below, so nothing is exempt by omission.
app.use("*", sessionGuard);
app.route("/api/sessions", sessionsRoute);
app.route("/api/stories", storiesRoute);
app.route("/api/layout", layoutRoute);
app.route("/api/agents", agentsRoute);
app.route("/api/prompts", promptsRoute);
app.route("/api/settings", settingsSpacesRoute);
app.route("/api/client-errors", clientErrorsRoute);
app.get("/api/debug/slots", (c) => c.json({ used: getSlotsInUse(), max: getMaxSlots() }));

const port = Number(process.env.PORT ?? 4113);

startPipelineRunner();
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Loremaster listening on http://localhost:${info.port}`);
});
