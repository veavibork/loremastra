# Backend Refactor Roadmap

Started 2026-07-13. Purpose: plan the backend overhaul identified in `evaluation-roadmap.md`
Phase 2 (Backend Architecture) and `next-session.md`. This roadmap follows the same format as
the completed `frontend-roadmap.md` — phased plan, open questions with tradeoffs, challenge of
prior decisions.

---

## 1. Current State: File Map

```
src/
├── index.ts                  4.9KB   Hono app, route registration, startup, health snapshots
├── config.ts                 3.1KB   AgentProfile interface + default profiles (Author/Editor/Worker)
├── prompts.ts                20.8KB  All prompt templates (Author system, Editor setup/update, naming, etc.)
│
├── routes/                           HTTP route handlers (8 files)
│   ├── stories.ts            38.6KB  ← largest route file (1013 lines, ~25 handlers)
│   ├── agents.ts             5.7KB
│   ├── account.ts            3.1KB
│   ├── layout.ts             2.1KB
│   ├── settings-spaces.ts    2.1KB
│   ├── sessions.ts           1.1KB
│   ├── client-errors.ts      1.5KB
│   └── prompts.ts            217B    (thin proxy)
│
├── services/                         26 flat files, no subdirectories
│   ├── story-to-date-engine.ts 29.2KB  ← largest service (636 lines, corpus + fold + prompt builders)
│   ├── story-to-date-worker.ts 10.1KB
│   ├── worldbook-compact.ts     7.8KB
│   ├── context-manifest.ts      5.0KB
│   ├── prompt-catalog.ts        4.4KB
│   ├── context-invalidation.ts  4.3KB
│   ├── story-to-date.ts         9.3KB
│   ├── agent-config.ts          4.0KB
│   ├── story-to-date-view.ts    3.3KB
│   ├── story-to-date-fold-worker.ts 3.9KB
│   ├── history.ts               4.6KB
│   ├── layout.ts                8.7KB
│   ├── worldbook-assembly.ts    3.8KB
│   ├── worldbook-extraction.ts  1.8KB
│   ├── post-index.ts            3.3KB
│   ├── fork.ts                  3.2KB
│   ├── log-view.ts              2.5KB
│   ├── refusal-detection.ts     2.2KB
│   ├── prompt-preview.ts        2.0KB
│   ├── story-read-cache.ts      1.1KB
│   ├── content-fingerprint.ts   731B
│   ├── generation-presets.ts    1.5KB
│   ├── settings-space-registry.ts 1.6KB
│   ├── story-stats.ts           1.2KB
│   ├── display-preferences.ts   533B
│   └── story-transition.ts      982B
│
├── queue/                            Job pipeline (5 files)
│   ├── pipeline-runner.ts    53.8KB  ← god object (1491 lines, all job dispatch + execution)
│   ├── job-events.ts         4.7KB   SSE event bus (pub/sub for job progress)
│   ├── concurrency-feed.ts   5.2KB   Featherless account concurrency stream
│   ├── slots.ts              2.9KB   Slot acquisition (live + fallback)
│   └── job-lanes.ts          1.5KB   Prose vs worker lane gating
│
├── inference/                        Provider integrations (12 files)
│   ├── featherless.ts        24.1KB  Streaming, fallback, tool-calls, reasoning detection
│   ├── cline-worker.ts       11.8KB  MCP worker server (separate concern, not inference)
│   ├── horde.ts              7.1KB   Submit-then-poll async provider
│   ├── reasoning-stream.ts   3.5KB   Reasoning/content stream splitter
│   ├── outbound-telemetry.ts 3.4KB   Request logging + createLogger
│   ├── featherless-models.ts 5.9KB   Model discovery
│   ├── featherless-tag-ratings.ts 2.5KB
│   ├── hf-model-tags.ts      845B
│   ├── horde-slots.ts        802B
│   ├── featherless-config.ts 967B
│   ├── horde-config.ts       751B
│   └── schema/                       Raw API test kit (diagnostic, not runtime)
│
├── db/                               SQLite stores + schema (22 files)
│   ├── story-db.ts           10.5KB  Connection management, ensureColumn, migrations
│   ├── job-store.ts          10.1KB
│   ├── model-config-store.ts 8.1KB
│   ├── story-schema.ts       6.8KB
│   ├── page-store.ts         5.9KB
│   ├── story-to-date-store.ts 6.3KB
│   ├── worldbook-store.ts    4.9KB
│   ├── history-store.ts      4.9KB
│   ├── user-store.ts         4.8KB
│   ├── global-schema.ts      4.9KB
│   ├── session-store.ts      3.6KB
│   ├── text-store.ts         3.5KB
│   ├── story-store.ts        3.0KB
│   ├── layout-config-store.ts 2.9KB
│   ├── story-state-store.ts  2.8KB
│   ├── settings-space-store.ts 2.5KB
│   ├── agent-config-store.ts 2.0KB
│   ├── book-store.ts         1.9KB
│   ├── content-store.ts      1.7KB
│   ├── client-error-store.ts 1.5KB
│   ├── global-db.ts          1.7KB
│   └── data-paths.ts         540B
│
├── lib/                              Shared utilities (6 files)
│   ├── crypto.ts             2.0KB
│   ├── pipeline-health.ts    1.9KB
│   ├── validation-hook.ts    1.1KB
│   ├── errors.ts             700B
│   ├── uuid.ts               107B
│   └── time.ts               71B
│
├── middleware/
│   └── session-guard.ts      3.3KB
│
├── mcp/                              Dev-tools MCP server (3 files)
│   ├── cline-worker.ts       11.8KB  ← misplaced (MCP worker, not inference)
│   ├── dev-server.ts         10.1KB
│   └── single-instance.ts    2.8KB
│
└── defaults/                         Bundled data (3 files)
    ├── featherless-tag-ratings.json 59.4KB
    ├── hf-model-tags.json           280B
    └── global-css.ts                900B
```

### Size summary

| Tier          | Files                                            |
| ------------- | ------------------------------------------------ |
| 1000+ lines   | `pipeline-runner.ts` (1491), `stories.ts` (1013) |
| 500–999 lines | `story-to-date-engine.ts` (636)                  |
| 300–499 lines | `featherless.ts` (~681)                          |
| 100–299 lines | 12 files                                         |

---

## 2. Route / Service / DB Layering Assessment

### Current layering

```
routes/ → services/ → db/*-store.ts → SQLite
         ↘ queue/pipeline-runner.ts → inference/* → provider API
```

Routes call stores directly for most reads and writes. The `stories.ts` route (1013 lines) is
the main offender — it performs business logic inline: page creation, history events, memory
invalidation, job creation, state transitions.

### Findings

| Issue                                       | Severity           | Detail                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **stories.ts does business logic**          | Should-fix (F-015) | 1013 lines, ~25 handlers. POST /:id/messages creates pages, sets state, records history, creates jobs, enqueues memory — 6+ DB operations across 4 stores in one handler. POST /:id/posts/:pageId/retry, POST /:id/kickoff, POST /:id/setup/messages all follow the same pattern. |
| **Routes call stores directly**             | Should-fix (F-029) | `stories.ts` imports from 15+ store modules. No service layer between route and store for most operations. The `openTrackedStoryDb` helper in the route file is infrastructure that belongs in a service or db layer.                                                             |
| **Pipeline-runner imports services**        | Expected           | `pipeline-runner.ts` imports from `services/story-to-date.ts`, `services/history.ts`, `services/worldbook-*.ts`, `services/agent-config.ts`. This is the expected direction (queue → service → store).                                                                            |
| **Services bypass stores for some queries** | Should-fix (F-029) | `context-manifest.ts` and `story-stats.ts` write raw `db.prepare()` queries instead of going through stores. `story-to-date.ts` also has inline `db.prepare()` for job-existence checks.                                                                                          |

### Verdict

The route layer is too thick. `stories.ts` is doing what should be service-level work: page
creation + state mutation + history + job creation is a multi-step business transaction that
belongs in a service, not a route handler. The DB layer is clean (one store per entity,
consistent patterns), but services sometimes bypass it for ad-hoc queries.

---

## 3. pipeline-runner.ts Complexity Assessment (F-031, F-012)

### What lives in this 1491-line file

| Section                             | Lines     | Responsibility                                                |
| ----------------------------------- | --------- | ------------------------------------------------------------- |
| Imports + constants                 | 1–96      | 18 imports, job type arrays, guidance maps                    |
| `applyGenerationOptions`            | 124–141   | Maps UI toggles to profile + chatTemplateKwargs               |
| Name extraction helpers             | 143–213   | `extractStoryName`, `isValidExtractedName`, word-limit checks |
| `handleStreamingCancel`             | 247–284   | Partial-commit logic for user-cancelled streams               |
| `streamWithFallback`                | 286–415   | Model fallback wrapper around `streamInference`               |
| Scan loop                           | 421–511   | `startPipelineRunner`, `scanOnce`, `trackedDbs` management    |
| `dispatchWorkerJobs`                | 524–614   | Worker lane dispatch (story-to-date, name, worldbook-compact) |
| `dispatchProseJob`                  | 616–669   | Prose lane dispatch (prose, setup, setup-worldbook, Horde)    |
| `buildProseHistory`                 | 675–714   | Prompt assembly for Author prose jobs                         |
| `executeProseJob`                   | 716–796   | Featherless streamed prose execution                          |
| `executeHordeProseSubmit`           | 807–826   | Horde submit (non-blocking)                                   |
| `scanHordeJobs` + `resolveHordeJob` | 847–927   | Horde poll loop                                               |
| `buildSetupConversation`            | 938–958   | OOC/setup history assembly                                    |
| `buildIcContextBlock`               | 966–979   | Read-only IC context for update sessions                      |
| `executeSetupJob`                   | 990–1122  | Editor setup/update job execution                             |
| `executeSetupWorldbookJob`          | 1131–1218 | Dual-pass worldbook extraction job                            |
| `maybeQueueStoryNameJob`            | 1228–1246 | Auto-name trigger                                             |
| `executeStoryNameJob`               | 1255–1308 | Worker story naming                                           |
| `executeWorldbookCompactJob`        | 1310–1334 | Worldbook compaction                                          |
| `executeStoryToDateNameJob`         | 1337–1395 | Segment naming                                                |
| `executeStoryToDateJobWrapper`      | 1397–1442 | Forward story-to-date wrapper                                 |
| `executeStoryToDateFoldJobWrapper`  | 1444–1481 | Fold story-to-date wrapper                                    |

### Concerns identified

| Concern                                | Severity   | Detail                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mixed concerns**                     | Should-fix | Job dispatch (scan loop, lane management), job execution (8 executor functions), prompt assembly (`buildProseHistory`, `buildSetupConversation`), and business logic (`maybeQueueStoryNameJob`, `maybeEnqueueStoryToDateJob`) all in one file.                                            |
| **Prompt assembly in the wrong place** | Should-fix | `buildProseHistory` and `buildSetupConversation` are prompt-assembly functions that belong alongside `assembleAuthorPrompt` in `services/history.ts`. They're here because they're called by executors, but the concern is service-layer, not queue-layer.                                |
| **Module-level mutable state**         | Info       | 6 `Map`/`let` module-level variables (`jobGuidance`, `jobGenerationOptions`, `streamingModels`, `runningControllers`, `trackedDbs`, `timer`). This is the right pattern for a singleton scan loop, but it means the module is effectively a global. Not a bug, but a coupling constraint. |
| **Error handling repetition**          | Info       | Every executor has the same try/catch/finally shape: `JobCancelledError` → `handleStreamingCancel`, other → `finishJob('failed')`, finally → release slot + lane. This is 8 repetitions of the same pattern.                                                                              |
| **Horde interleaved**                  | Info       | Horde submit/poll logic is interleaved with Featherless logic rather than separated. `dispatchProseJob` branches on provider; `scanHordeJobs` runs alongside the main scan.                                                                                                               |

### Verdict

pipeline-runner.ts is a god object, but a _coherent_ one — every function is either dispatch
or execution of a job. The problem isn't mixed _domains_ (it's all about jobs); it's mixed
_layers_ (dispatch, execution, and prompt assembly all at the same level). The fix is
decomposition by layer, not by domain.

---

## 4. services/ Flat Directory Assessment (F-005)

### Current clusters

| Cluster          | Files                                                                                                                             | Total size |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Story-to-date    | `story-to-date.ts`, `story-to-date-engine.ts`, `story-to-date-worker.ts`, `story-to-date-fold-worker.ts`, `story-to-date-view.ts` | 56.7KB     |
| Worldbook        | `worldbook-compact.ts`, `worldbook-assembly.ts`, `worldbook-extraction.ts`                                                        | 13.4KB     |
| Context/memory   | `context-manifest.ts`, `context-invalidation.ts`, `content-fingerprint.ts`                                                        | 10.0KB     |
| Prompt           | `prompt-catalog.ts`, `prompt-preview.ts`                                                                                          | 6.4KB      |
| Story management | `story-stats.ts`, `story-read-cache.ts`, `story-transition.ts`, `fork.ts`, `history.ts`, `log-view.ts`                            | 18.2KB     |
| Config           | `agent-config.ts`, `settings-space-registry.ts`, `generation-presets.ts`, `display-preferences.ts`                                | 8.1KB      |
| Layout           | `layout.ts`                                                                                                                       | 8.7KB      |
| Safety           | `refusal-detection.ts`                                                                                                            | 2.2KB      |
| Post indexing    | `post-index.ts`                                                                                                                   | 3.3KB      |

### Verdict

26 flat files with clear thematic clusters. The story-to-date cluster alone is 56.7KB across
5 files — it's practically its own subdirectory already. The worldbook and context clusters
are similarly self-contained. This is the most impactful structural cleanup on the backend.

---

## 5. Inference Provider Abstraction Assessment (F-032)

### Current state

```
config.ts: AgentProfile.provider?: 'featherless' | 'horde'
                ↓
pipeline-runner.ts dispatchProseJob():
  if provider === 'horde':
    executeHordeProseSubmit() → horde.ts submitTextGeneration()
    scanHordeJobs() → horde.ts pollTextGeneration()
  else:
    executeProseJob() → featherless.ts streamInference()
```

Featherless and Horde have **no shared interface**. They don't share a type, a dispatch
contract, or a result shape. The branching is baked into `pipeline-runner.ts` at the dispatch
level.

### Differences between providers

| Aspect             | Featherless                                         | Horde                                                                                                                     |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Transport          | Streaming SSE                                       | Submit-then-poll                                                                                                          |
| Concurrency signal | Account-wide stream (`/account/concurrency/stream`) | None — submission rate limited to 2/sec per IP (not per-key)                                                              |
| Slot management    | `slots.ts` + `concurrency-feed.ts` (per-user)       | `horde-slots.ts` (process-wide, needs rework → rate limiter)                                                              |
| Concurrency weight | Per-model cost (1/2/4/8 slots)                      | None — all jobs equal weight                                                                                              |
| Model fallback     | `withModelFallback` (ranked-choice)                 | Not implemented                                                                                                           |
| Reasoning streams  | `delta.reasoning` SSE chunks                        | Not supported                                                                                                             |
| Tool calling       | `callWithTools`                                     | Not confirmed                                                                                                             |
| API shape          | OpenAI-compatible chat completions                  | Plain-text completion                                                                                                     |
| Output token cap   | Tier-dependent (responseLimit in AgentProfile)      | 512 tokens for anonymous/low-kudos users (HTTP 403 `KudosUpfront`)                                                        |
| Context limit      | Tier-dependent (contextLimit in AgentProfile)       | `max_context_length` min=80 max=1,048,576 default=2048; actual limit depends on serving workers, not queryable in advance |

### Horde-specific findings (live-tested 2026-07-13)

**Rate limit is per-IP, not per-key.** The Horde enforces 2 requests/second per IP address
(`limiter_api.py: get_request_2sec_limit_per_ip`). Two Lorepalace users on the same VM share
a single 2/sec submission budget regardless of their different API keys. This is a submission
rate limit, not an in-flight concurrency cap — 4 jobs ran simultaneously without error when
submitted with 1.1s spacing. The current `horde-slots.ts` in-flight cap of 2 is overly
conservative and should be replaced with a central rate-limited submission handler.

**Kudos cap.** Requests with `max_length` > 512 require upfront kudos. Anonymous users
(0 kudos) are hard-capped at 512 output tokens. The error shape is:

```json
HTTP 403 { "message": "...requires N kudos to fulfil.", "rc": "KudosUpfront" }
```

Strategy: on `KudosUpfront`, cap `max_length` to 512 for that model going forward. No need
to parse the kudos amount.

### Verdict

A common adapter interface is _desirable_ but the two providers are genuinely different
enough that a forced abstraction would be leaky. The real problem isn't the lack of an
interface — it's that the provider branching lives in `pipeline-runner.ts` instead of behind
a dispatch boundary. Moving the branching out of the runner (into a `provider-dispatch.ts`)
achieves most of the value without a premature shared interface.

---

## 6. Queue / Lane Design Assessment

### Current design

```
scanOnce() runs every 500ms:
  1. scanHordeJobs() for each tracked story
  2. cancelPendingTagGenJobs() for each tracked story
  3. dispatchWorkerJobs() — worker lane (story-to-date, name, compact)
  4. dispatchProseJob() per story — prose lane (prose, setup, setup-worldbook)

### Findings

| Issue | Severity | Detail |
|-------|----------|--------|
| **Lane mutual exclusion is wrong** | Should-fix | `job-lanes.ts` prevents workers from running during prose. This was correct when all prose was cost-4 on a 4-slot account (slots would block workers anyway). But on an 8-slot account, a 4-slot prose job leaves room for 1-slot workers. The lane lock prevents this for no reason. **Fix:** Remove cross-lane exclusion; let `slots.ts` be the sole gatekeeper. Keep per-lane thread caps (`PROSE_THREADS`, `WORKER_THREADS`) but don't make them mutually exclusive. |
| **Scan order is backwards** | Should-fix | `scanOnce()` dispatches workers first, then prose. Prose (user-facing) should dispatch first to claim slots before workers fill them. |
| **`priority` field is dead** | Should-fix | `createJob` accepts `priority` but `claimNextJob` does FIFO (`ORDER BY created_at ASC`). `story-name` sets `priority: -1` — silently meaningless. Fix: `ORDER BY priority DESC, created_at ASC` in `claimNextJob`. |
| **Context-pressure blocking** | Design decision | When context is choked (>80%) and no segment is ready, prose should wait for the segment to complete before dispatching — a choked-context prose run produces degraded output. On 8-slot accounts, both can run in parallel (segment + prose). On 4-slot accounts, the segment must finish first. The slot system handles this naturally if we gate prose dispatch on context health. |
| **500ms poll interval** | Info | Synchronous `setInterval` scanning `trackedDbs`. Fine for <10 users, one active story each. Would need event-driven dispatch at scale. Not a current problem. |
| **`trackedDbs` is process-local** | Info | If the process restarts, all story DBs are re-tracked at boot via `trackAllStoriesAtStartup()`. Fine for single-process deployment. |
| **`concurrencyCost` hardcoded to 4** | Bug for $25 users | `DEFAULT_AUTHOR_PROFILE` and `DEFAULT_EDITOR_PROFILE` hardcode `concurrencyCost: 4`. On a $25 account with a 2-slot model, this blocks all dispatch because a 2-slot job reserves 4 slots. The cost should come from the model's actual Featherless-reported cost, not a hardcoded default. |
| **Horde submission rate** | Should-fix | Horde enforces 2 submissions/sec per IP (not per-key). Current `horde-slots.ts` is an in-flight cap of 2, which is the wrong model. Needs a central rate-limited submission handler so 3 users hitting Horde simultaneously get queued at 1.1s spacing. |

---

## 7. API Contract Shape Assessment

### Current patterns

- **Auth:** session token via `Authorization: Bearer` or cookie. `session-guard.ts` middleware.
- **Ownership:** `requireStoryOwnership` middleware in `stories.ts` — one check for all `/:id/*` routes.
- **Validation:** `@hono/standard-validator` + Zod on 5 route files. `validationHook` maps Zod issues to `{ error: string }`.
- **Errors:** `c.json({ error: message }, status)`. No standard error response shape beyond `{ error }`.
- **SSE:** `GET /:id/jobs/:jobId/stream` — subscribe-then-read pattern, heartbeat every 15s, `[DONE]` terminator.
- **Response shape:** Inconsistent. Some return `{ ok: true }`, some `{ job }`, some `{ userPageId, agentPageId, jobId }`. No envelope.

### Findings

| Issue | Severity | Detail |
|-------|----------|--------|
| **No response envelope** | Nice-to-have | Mix of `{ ok }`, `{ job }`, `{ entries }`, bare values. A standard `{ data, error }` envelope would make the frontend's error handling simpler. |
| **Validation coverage** | Info | 5 of 8 route files have Zod validation. `stories.ts` (the largest) does manual `c.req.json().catch(() => ({}))` + ad-hoc checks. |
| **`ARCHIVE_NAMING_PROMPT` still imported** | Info | `pipeline-runner.ts` imports `ARCHIVE_NAMING_PROMPT` — a leftover name from the retired archive system. It's used for segment naming, not archives. The prompt text in `prompts.ts` may still work, but the name is misleading. |

---

## 8. Type Safety Assessment

### Findings

| Issue | Severity | Detail |
|-------|----------|--------|
| **`as` casts in services** | Nice-to-have | `layout.ts` uses `as unknown as LayoutConfigData` and `as unknown as LayoutConfigV1` for runtime type narrowing. Acceptable for migration code but should be replaced with Zod parsing. |
| **`as` casts in DB queries** | Nice-to-have | `context-manifest.ts:96` and `story-stats.ts:17,26` use `as { id: string }` / `as { n: number }` on raw `db.prepare().get()`. This is the standard better-sqlite3 pattern — the alternative is generic store helpers, which would be over-engineering. |
| **No runtime response validation** | Info | Provider responses (Featherless, Horde) are trusted as-is. No Zod validation on inbound provider data. Acceptable — the providers are the source of truth for their own responses. |
| **AgentProfile typing** | Good | `config.ts` defines a clean interface with optional fields. `getAgentProfile()` returns a fully-resolved profile with defaults filled in. |

---

## 9. Error Handling Assessment

### Current patterns

- **Route handlers:** `try/catch` → `c.json({ error: message }, 400)`. Some routes don't catch at all (relying on the global Hono error handler).
- **Pipeline executors:** `try/catch/finally` with `JobCancelledError` special-cased, other errors → `finishJob('failed')` + `publishError()`. Finally always releases slots/lanes.
- **Global:** `process.on('unhandledRejection')` and `process.on('uncaughtException')` → `logUnhandledError()`. The latter exits the process.
- **Provider errors:** `FeatherlessError` carries HTTP status for model-fallback decisions. `HordeError` mirrors this. `JobCancelledError` distinguishes user-cancel from failure.

### Findings

| Issue | Severity | Detail |
|-------|----------|--------|
| **No structured error types** | Nice-to-have | Errors are strings throughout. No `NotFoundError`, `ValidationError`, `ConflictError` etc. The route layer translates everything to `{ error: string }` + status code. This works but makes error-specific handling in the frontend impossible beyond "check the message." |
| **Route catch blocks are inconsistent** | Info | Some routes catch and format (`stories.ts` fork, worldbook), others don't (`position`, `jobs`). The global handler catches unhandled errors but produces a generic 500. |
| **`handleStreamingCancel` complexity** | Info | The partial-commit logic for cancelled streams is correct but dense — it has to decide whether the partial content is worth saving, commit it if so, and handle both prose and setup paths. This is inherently complex; not a refactor target, but a risk area. |

---

## 10. Challenge of Prior Decisions

### 10.1 "Prose blocks all workers" lane design — **UPHOLD**

`job-lanes.ts` prevents workers from running during prose generation. This was designed for
Featherless cost-4 models where prose consumes all account slots. With a cost-1 Worker model
(Hermes-3-8B), the Worker *could* run concurrently with prose without exceeding the account
limit. However, the current design is correct for the primary use case (DeepSeek-V4-Pro =
4 slots = all slots consumed). Changing this would be a premature optimization for a <10-user
system. **Stays as-is.**

### 10.2 "No job priority within lanes" — **OVERRIDE: implement priority**

The evaluation recommended removing the `priority` field entirely. But the field exists for a
reason: prose (user-facing) should dispatch before workers (background), and within a lane,
story-to-date should overtake prose when context is choked.

**Decision: implement.** `ORDER BY priority DESC, created_at ASC` in `claimNextJob`. Prose
(10) dispatches before workers (-1). Context-pressure blocking (Phase 4.5) can elevate
story-to-date priority above prose when the assembled prompt exceeds 80% of context.

The lane mutual-exclusion removal (§6, Decision 6) makes this even more important: without
the lock, both lanes compete for the same slot pool. Priority ensures prose claims slots
before workers when both are waiting.

### 10.3 "Services bypass stores for ad-hoc queries" (F-029) — **UPHOLD with caveat**

`context-manifest.ts` and `story-stats.ts` write raw SQL. This is technically a store-bypass,
but both are read-only diagnostic queries that aggregate across tables — they don't belong in
any single store. Creating a "query" or "read-model" store for each would be over-engineering.
The `story-to-date.ts` job-existence checks are a real bypass and should use `job-store.ts`.

### 10.4 "No common provider interface" (F-032) — **CHALLENGE the evaluation's recommendation**

The evaluation says "extracting a common adapter interface is a known improvement." But
Featherless and Horde differ in transport (streaming vs poll), concurrency (account-wide vs
per-request), fallback (ranked-choice vs none), and capabilities (reasoning, tool-calls). A
shared `InferenceProvider` interface would be either so generic it's useless
(`generate(input): Promise<output>`) or so leaky it doesn't abstract anything.

**Recommendation:** Don't build a shared interface. Instead, extract provider dispatch
*out of* `pipeline-runner.ts` into a `provider-dispatch.ts` that owns the
Featherless-vs-Horde branching. The runner calls `dispatchProseJob()` which internally routes
to the right provider. This achieves separation without a forced abstraction.

### 10.5 "prompts.ts at src/ root" (F-010) — **UPHOLD as minor**

The evaluation recommended moving `prompts.ts` to `services/`. It's 20.8KB of prompt
templates — data, not logic. It belongs at `src/` root alongside `config.ts` (also data).
Moving it to `services/` would imply it's a service, which it isn't. **Stays at root.**

### 10.6 "Split pipeline-runner.ts into orchestration/dispatch/retry" (F-031) — **REFINE**

The evaluation's suggested split (orchestration, job dispatch, retry/recovery) is directionally
correct but doesn't match the actual concern boundaries. The real split is:

1. **Dispatch** (scan loop, lane/slot acquisition, job claiming) → `queue/dispatch.ts`
2. **Executors** (the 8 `execute*Job` functions + their helpers) → `queue/executors/`
3. **Prompt assembly** (`buildProseHistory`, `buildSetupConversation`, `buildIcContextBlock`) → `services/` (alongside `history.ts`)
4. **Cancel handling** (`handleStreamingCancel`, `requestJobCancel`, `runningControllers`) → `queue/cancel.ts`
5. **Module state** (`trackedDbs`, `jobGuidance`, `jobGenerationOptions`, `streamingModels`) → stays in dispatch, with accessor exports

---

## 11. Open Questions

### Q1: How aggressively to split pipeline-runner.ts?

**Option A: Full decomposition (5 files)**
- Pro: Each file <300 lines, single concern per file, testable in isolation.
- Con: 5 files for one subsystem. The module-level state (`trackedDbs`, `runningControllers`)
  needs accessor exports across files, increasing coupling surface.
- Risk: The executors share state (guidance maps, streaming models) that would need to be
  passed or exported.

**Option B: Moderate split (3 files)**
- `queue/dispatch.ts` — scan loop, lane/slot, tracked DBs, cancel controllers
- `queue/executors.ts` — all 8 executor functions + shared helpers
- `services/history.ts` gains `buildProseHistory`, `buildSetupConversation`, `buildIcContextBlock`
- Pro: Each file is 400–600 lines, still navigable. Minimal cross-file state exports.
- Con: `executors.ts` is still a large file (8 functions), but all share the same pattern.

**Option C: Minimal (2 files)**
- Move only prompt assembly to `services/history.ts`. Leave dispatch + executors in
  `pipeline-runner.ts`.
- Pro: Lowest risk. Addresses the layering concern (prompt assembly in wrong place) without
  touching the execution core.
- Con: `pipeline-runner.ts` is still ~1300 lines.

### Q2: services/ subdirectory grouping — by domain or by layer?

**Option A: By domain**
```

services/
├── story-to-date/ (engine, worker, fold-worker, view, service)
├── worldbook/ (compact, assembly, extraction)
├── context/ (manifest, invalidation, fingerprint)
├── prompt/ (catalog, preview)
├── story/ (stats, read-cache, transition, fork, history, log-view)
├── config/ (agent-config, settings-space-registry, generation-presets, display-preferences)
├── layout/ (layout.ts)
├── safety/ (refusal-detection.ts)
└── indexing/ (post-index.ts)

```
- Pro: Related files are co-located. Clear ownership boundaries. Matches frontend's
  `views/`, `components/`, `hooks/` approach.
- Con: 9 subdirectories for 26 files — some dirs have 1 file (`layout/`, `safety/`,
  `indexing/`). Over-structured.

**Option B: By domain, only for clusters of 3+**
```

services/
├── story-to-date/ (5 files, 56.7KB)
├── worldbook/ (3 files, 13.4KB)
├── context/ (3 files, 10.0KB)
├── prompt.ts (merged catalog + preview? or keep flat)
├── layout.ts
├── ... (remaining flat)

```
- Pro: Only groups what's actually a cluster. No 1-file directories.
- Con: Inconsistent — some files in subdirs, some flat.

**Option C: Flat with naming convention**
- Keep all 26 files flat, but enforce a naming prefix convention: `story-to-date-*`,
  `worldbook-*`, `context-*`, etc. IDE sorting groups them automatically.
- Pro: Zero file moves. Already partially in place (most files follow this pattern).
- Con: 26 files in one directory is still a lot to scan visually.

### Q3: Should stories.ts be split by resource or by operation type?

`stories.ts` (1013 lines, ~25 handlers) handles: stories CRUD, messages, posts (retry/edit),
continue, position (undo/redo/rewind), fork, setup messages, kickoff, OOC sessions, worldbook
CRUD, worldbook compact, jobs (list/active/get/cancel/stream), story-to-date segments, context
(manifest/summary/backfill/enqueue).

**Option A: Split by resource domain**
```

routes/stories/
├── index.ts (story CRUD: create, list, rename, delete, log, phase)
├── messages.ts (POST /:id/messages, continue, setup/messages, kickoff, ooc/start-session)
├── posts.ts (retry, edit)
├── position.ts (get, undo, redo, rewind)
├── fork.ts (fork)
├── worldbook.ts (CRUD, compact)
├── jobs.ts (list, active, get, cancel, stream)
├── segments.ts (story-to-date CRUD, enqueue, requeue, backfill)
└── context.ts (manifest, summary, backfill, enqueue)

```
- Pro: Each file <200 lines. Clear resource ownership. Matches the frontend's api/ split.
- Con: The shared `requireStoryOwnership` middleware and `openTrackedStoryDb` helper need
  to be extracted to a shared module. 9 files for one route.

**Option B: Extract services, keep route flat**
- Move business logic (page creation, state mutation, job creation) into
  `services/story-ops.ts`. Routes become thin: parse request → call service → format response.
- Pro: `stories.ts` shrinks to ~400 lines of thin handlers. Service is testable without HTTP.
- Con: `story-ops.ts` could itself become large. The route is still one file.

**Option C: Both — split routes AND extract services**
- Pro: Cleanest separation. Routes are thin HTTP adapters, services hold business logic,
  each in a focused file.
- Con: Most files to create. Most import-path updates. Highest risk of breakage.

### Q4: Remove the `priority` field from jobs?

The `priority` field on `createJob` is accepted but ignored by `claimNextJob` (FIFO only).
`story-name` jobs set `priority: -1` — aspirational, not functional.

**Option A: Remove the field entirely**
- Pro: Stops pretending. One less field in the schema. No dead code.
- Con: If priority is ever needed, it has to be re-added. But for <10 users, FIFO is correct.

**Option B: Implement priority in `claimNextJob`**
- Pro: The field works as documented. Story-name jobs actually run after prose jobs.
- Con: SQLite `ORDER BY priority` in the claim query. Minimal complexity. But what does
  "priority" mean when there's one active story? The user's prose job is always more important
  than background naming.

**Recommendation:** Option A (remove). The lane system already handles the only priority that
matters: prose preempts workers. Within a lane, FIFO is correct for this scale.

### Q5: Rename `ARCHIVE_NAMING_PROMPT`?

`pipeline-runner.ts` imports `ARCHIVE_NAMING_PROMPT` from `prompts.ts`. Archives are retired.
The prompt is used for segment naming. The name is a fossil.

**Option A: Rename to `SEGMENT_NAMING_PROMPT`**
- Pro: Accurate. No misleading "archive" reference.
- Con: Touches `prompts.ts` + `pipeline-runner.ts`. Trivial.

**Option B: Leave it**
- Pro: Zero work.
- Con: Confuses anyone reading the code who doesn't know the archive retirement history.

**Recommendation:** Option A. It's a 2-file rename.

---

## 12. Proposed Phased Plan

### Phase 1: services/ reorganization (F-005) — low risk, high clarity

| # | Item | Effort | Depends on |
|---|------|--------|------------|
| 1.1 | Group story-to-date files into `services/story-to-date/` (5 files) | 15 min | — |
| 1.2 | Group worldbook files into `services/worldbook/` (3 files) | 10 min | — |
| 1.3 | Group context files into `services/context/` (3 files) | 10 min | — |
| 1.4 | Update all import paths across `src/` | 30 min | 1.1–1.3 |
| 1.5 | Verify: `npx tsc --noEmit -p tsconfig.app.json` + `npm run lint` + `npm test` | 5 min | 1.4 |

Remaining services stay flat (naming convention already groups them). Only 3+ file clusters
get subdirectories.

### Phase 2: Extract story operations + split routes (F-015, F-029) — medium risk

| # | Item | Effort | Depends on |
|---|------|--------|------------|
| 2.1 | Create `services/story-ops.ts` — extract page creation, state mutation, history recording, job creation from `stories.ts` route handlers | 2–3 hr | Phase 1 |
| 2.2 | Split `routes/stories.ts` into `routes/stories/` subdirectory (9 resource modules) | 2–3 hr | 2.1 |
| 2.3 | Move `openTrackedStoryDb` to a shared location (db layer or service) | 15 min | 2.1 |
| 2.4 | Move `buildProseHistory`, `buildSetupConversation`, `buildIcContextBlock` from `pipeline-runner.ts` to `services/history.ts` | 30 min | 2.1 |
| 2.5 | Fix store bypasses: move `story-to-date.ts` job-existence checks to `job-store.ts` | 15 min | 2.1 |
| 2.6 | Verify: typecheck + lint + test + E2E | 10 min | 2.5 |

Routes become thin HTTP adapters (parse request → call service → format response). Services
hold business logic. Each route file <200 lines. Work one route at a time, verify between
each — we will break things and fix them in a loop.

### Phase 3: pipeline-runner.ts full decomposition (F-031) — higher risk

| # | Item | Effort | Depends on |
|---|------|--------|------------|
| 3.1 | Extract cancel handling (`handleStreamingCancel`, `requestJobCancel`, `runningControllers`) → `queue/cancel.ts` | 1 hr | Phase 2 |
| 3.2 | Extract provider dispatch (Featherless/Horde branching) → `queue/provider-dispatch.ts` | 1–2 hr | 3.1 |
| 3.3 | Extract executors → `queue/executors/` (one file per job type: `prose.ts`, `setup.ts`, `setup-worldbook.ts`, `story-name.ts`, `segment-name.ts`, `worldbook-compact.ts`, `story-to-date.ts`, `story-to-date-fold.ts`) | 2–3 hr | 3.2 |
| 3.4 | `pipeline-runner.ts` becomes `queue/dispatch.ts` — scan loop, lane/slot acquisition, tracked DBs, module state | 1 hr | 3.3 |
| 3.5 | Verify: typecheck + lint + test + E2E + manual smoke (submit post, retry, setup, worldbook) | 15 min | 3.4 |

Full decomposition (5 files + executors/). Module-level state (`trackedDbs`,
`runningControllers`, guidance maps) stays in `dispatch.ts` with accessor exports.
Shared state is an additional task, not a risk — the foundation for formal state management
already exists.

### Phase 4: Queue and priority redesign — medium risk

| # | Item | Effort | Depends on |
|---|------|--------|------------|
| 4.1 | Remove lane mutual exclusion from `job-lanes.ts` — keep per-lane thread caps, let `slots.ts` be sole gatekeeper | 30 min | Phase 3 |
| 4.2 | Reverse scan order: prose dispatches before workers | 5 min | 4.1 |
| 4.3 | Implement `ORDER BY priority DESC, created_at ASC` in `claimNextJob` | 15 min | 4.1 |
| 4.4 | Fix `concurrencyCost` defaults — don't hardcode 4; use model's actual Featherless-reported cost | 1 hr | 4.1 |
| 4.5 | Add context-pressure gate: when context is choked (>80%) and no segment is ready, block prose dispatch until segment completes | 1–2 hr | 4.3 |
| 4.6 | Replace `horde-slots.ts` in-flight cap with central rate-limited submission handler (2/sec per IP, 1.1s spacing between submits) | 1–2 hr | 4.1 |
| 4.7 | Add `KudosUpfront` error handling: on HTTP 403 `rc=KudosUpfront`, cap `max_length` to 512 for that model going forward | 30 min | 4.6 |
| 4.8 | Verify: typecheck + lint + test + E2E + manual smoke under simulated $25 conditions (4 slots, 32k context) | 20 min | 4.7 |

### Phase 5: Cleanup passes — low risk

| # | Item | Effort | Depends on |
|---|------|--------|------------|
| 5.1 | Rename `ARCHIVE_NAMING_PROMPT` → `SEGMENT_NAMING_PROMPT` | 5 min | — |
| 5.2 | Add Zod validation to remaining route files (`stories.ts` submodules, `agents.ts`) | 1 hr | Phase 2 |
| 5.3 | Move `cline-worker.ts` from `inference/` to `mcp/` (it's an MCP server, not inference) | 10 min | — |
| 5.4 | Verify: typecheck + lint + test + E2E | 10 min | 5.1–5.3 |

### Phase 6: Known limitations (from next-session.md) — optional, per-item

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 6.1 | Apply fallback row params in `withModelFallback` | 1–2 hr | Currently only swaps `.model`, ignores temperature/sampler |
| 6.2 | Populate `gen_metrics` for background jobs | 1 hr | Story-to-date, naming, compaction jobs don't write metrics |
| 6.3 | `preference_profiles` CRUD | 2–3 hr | Table exists, no API or UI |
| 6.4 | Featherless server-side cancellation | — | **Non-fixable.** Featherless doesn't support server-side request cancellation. Aborting the client fetch may not free their concurrency slot until the generation finishes server-side. Tracked in `docs/roadmap.md` play-testing watch list. No code fix — provider limitation. |

### Phase 7: Condition testing — verify across all account tiers

| # | Item | Effort | Notes |
|---|------|--------|-------|
| 7.1 | Horde (anonymous key) — 512 token cap, 2/sec IP rate limit, no streaming | 1 hr | Test with `0000000000` key |
| 7.2 | Horde (registered key) — same rate limit, higher queue priority | 1 hr | Test with a registered API key |
| 7.3 | Featherless (2-slot / basic tier) — 1-slot worker only, no parallel prose+worker | 1 hr | Simulate 2-slot account |
| 7.4 | Featherless (4-slot / $25 tier) — cost-4 prose blocks all workers | 1 hr | Default test condition |
| 7.5 | Featherless (8-slot / $200 tier) — prose + workers in parallel | 1 hr | Test parallel lane dispatch |
| 7.6 | A/B test: 1-slot vs 2-slot models for worker tasks (segment construction, naming) | 2 hr | Compare result quality under load |

---

## 13. Decisions

All discussion items resolved:

1. **pipeline-runner.ts split depth** — **Full decomposition (5 files + executors/).** Shared state is an additional task, not a risk.
2. **services/ grouping** — **Hybrid (Option B): 3+ file clusters get subdirectories, rest stay flat.**
3. **stories.ts split** — **Both (Option C): split routes by resource AND extract services.** Work one route at a time; accept breakage and fix in a loop.
4. **Job priority field** — **Implement it.** `ORDER BY priority DESC, created_at ASC` in `claimNextJob`. Prose (10) dispatches before workers (-1). Context-pressure blocking can elevate story-to-date priority above prose when context is choked.
5. **`ARCHIVE_NAMING_PROMPT`** — **Rename to `SEGMENT_NAMING_PROMPT`.**
6. **Lane mutual exclusion** — **Remove.** Let `slots.ts` be sole gatekeeper. On 4-slot accounts, a cost-4 prose job naturally blocks workers. On 8-slot accounts, workers fill remaining slots.
7. **Scan order** — **Reverse: prose first, workers second.**
8. **Context-pressure behavior** — **Block prose until segment is ready when context is choked.** On 8-slot accounts, both run in parallel. On 4-slot accounts, segment must finish first. User accepts 4-5 minute waits — that's the platform's purpose.
9. **Horde submission** — **Central rate-limited handler.** 2/sec per IP, 1.1s spacing. All queueing beyond that happens Horde-side.
10. **`concurrencyCost` defaults** — **Fix: use model's actual Featherless-reported cost, don't hardcode 4.**
11. **Condition testing** — **5 tiers: Horde anonymous, Horde registered, Featherless 2-slot, 4-slot, 8-slot.**

---

_Backend refactor not yet started. All decisions confirmed. Ready for execution._
```
