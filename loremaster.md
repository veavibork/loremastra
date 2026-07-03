# Loremaster (LM) — Project Reference

---

## Working With This Document

This document is the authoritative reference for the Loremaster project. It is intended both as a repository README and as the primary context document for AI-assisted development sessions.

**If you are an AI coding assistant reading this:**

- Act as a senior engineer and architect, not just a code executor. Surface simpler or cheaper alternatives before building what's literally asked for. Flag when a proposed approach is heavier than the problem warrants.
- The person you're working with has ADHD. Work one step at a time. Do not move on to the next step until the current one is confirmed working. A "step" can be a series of actions taken in a single place, platform, or process — one click path.
- Confirm intent before building. The author may use a technical term from general knowledge rather than industry precision. When a request is ambiguous, restate your interpretation and get confirmation before proceeding.
- This person is not an expert. They have a strong grasp of the big picture and good instincts, but they may propose a solution that represents a heavy lift without realizing it. Always make sure you're aligned on what they're actually trying to achieve.
- When you join a session, your first job is to read this document and the codebase, then produce a short state-of-the-world summary: what exists, what's next, what's unresolved. Do not begin building until that summary is confirmed.

---

## Terminology

The following shorthand is used consistently throughout this document and codebase.

| Term | Definition |
|---|---|
| **LM** | Loremaster — this project |
| **market** | Existing RP platforms: SillyTavern, KoboldAI, CharacterAI, AI Dungeon, NovelAI, etc. |
| **host** | LM's back-end server (currently a GCP e2-micro VM) |
| **provider** | The LLM inference endpoint supplied by the user (Featherless and the Horde, as of the multi-user milestone) |
| **site** | LM's front end — a browser-accessible web application |
| **users** | LM's expected population: fewer than ten people |
| **story** | A single RP session/save slot — the core unit of LM's service |
| **ERP** | Explicit/adult roleplay content — the primary content type LM is built to support |
| **tag** | A keyword associated with a worldbook entry or post; the primary mechanism for lore retrieval |
| **verbose** | The full text of a single post (~200 tokens) |
| **compressed** | A factual distillation of a single post (~20 tokens) |
| **archived** | A narrative summary of a sliding block of ten posts (~60 tokens) |

---

## Mission Statement

Loremaster is a lightweight, private roleplaying platform for a small number of trusted users, built to support long-form ERP stories. Its value is not in replicating the market — it's in doing a narrow set of things the market does poorly, and doing them well.

The market's weaknesses that LM directly addresses:

- **Context window degradation:** Long stories break down as the context fills. Characters forget facts, flatten into caricatures, and repeat themselves. LM addresses this through structured log compression and tag-driven prompt assembly.
- **Provider inflexibility:** ERP requires uninhibited models. Model and provider selection is the primary guardrail strategy — prompt engineering plays a supporting role, not a defensive one.
- **Schema incoherence:** Market worldbooks are freeform. LM uses a consistent shared schema across all lore entries, prompts, and tooling, which keeps the LLM's inputs predictable and structured.

---

## Infrastructure

The following reflects the current hosting environment. These are provisional choices selected for availability and low cost, not hard requirements. Any of them may change.

- **Host:** GCP e2-micro VM (free tier). Adequate for a sub-10-user personal project with deferred background workers.
- **Storage:** SQLite. Deliberate and appropriate — not a default. A project of this scale and user count has no reason to operate a separate database server. SQLite's file-per-database model also maps cleanly to per-story isolation.
- **Inference provider:** Featherless ($25/mo tier), joined by the Horde as a second provider as of the multi-user milestone — see Provider Abstraction.
- **Front end:** Standard browser-accessible web application. Must be viable on Android and Windows without native app installation.

The current development environment will shift to locally hosted for initial buildout and hardening. Inference will remain Featherless, and browser testing will either target localhost or the external IP.

---

## Guardrails Philosophy

ERP content limits which providers are usable. The same model accessed through different channels may have very different behavior — Deepseek at source is heavily restricted; Deepseek through Featherless is largely uninhibited.

LM's approach to guardrails is through **model and provider selection**, not through prompt-level defensive engineering. A portion of the prompt is dedicated to *encouraging* ERP-aligned behavior, calibrated to user-specific preferences established during setup. Little to no prompt space is spent trying to override the model's trained refusals — if the model needs to be argued into compliance, it's the wrong model.

---

## The Core Problem

RP creates a fundamental tension with how LLMs are trained:

- The user asserts facts about their player character's behavior and expects them to be treated as canon — which is exactly what an LLM is trained to do with user input.
- But the user also expects the LLM to *oppose* the player character, introduce new facts, create conflict, and surprise them — which looks indistinguishable from the LLM contradicting the user, which it's trained not to do.
- And the user expects genuine novelty — not repetition of what got a positive response last time, which is exactly what RLHF incentivizes.

Compounding this: context limits are finite. At 32k tokens, a long story starts to degrade — characters contradict established facts, forget events, flanderize. Half of what the market sells is context management. LM's answer is a combination of structured schema, agentic prompting, and log compression — all three working together.

---

## Structured Schema

Worldbook entries are freeform prose, not structured fields. An earlier design used six typed
entry schemas (Setting/Register/Location/Creature/Faction/Character) with structured fields,
each populated via the Editor calling a validated tool per entry. That was tried and dropped
(2026-07-03) — model tool-calling reliably invoking the right schema, with the right field
casing, across a multi-turn conversation proved to be the weak link, not the schema design
itself (see docs/stub-revisions.md's superseded entry for the specifics that led to the
switch).

The current mechanism: the Editor writes plain prose during setup and OOC "update session"
turns, wrapping anything worldbook-worthy in a bracket tag. The back end detects these
deterministically via regex — no model-side tool call, no structured field extraction — and
stores the tagged span verbatim as a single string.

### Entry Types

**CONTENT** — Setting/premise/register material: the elevator pitch, tone, what's welcome,
what's off the table. Accumulates rather than singleton — later CONTENT entries are treated as
deltas/contradictions to earlier ones, not replacements. Always injected into every Author
prompt, in creation order.

**ROSTER** — A character, faction, creature, or location worth remembering — whatever the
Editor judges is worth recording, with no forced subdivision by kind. Tag-triggered like any
other non-CONTENT entry, not always-injected.

**MEMORY** — A story-state fact or event worth remembering going forward (an established
promise, a revealed secret, a changed relationship) — also tag-triggered, not always-injected.

### Bracket Format

```
[CONTENT]
A frontier mining town under Zhentarim influence, tone: grounded low fantasy, welcomes moral
ambiguity, off the table: sexual violence.
[/CONTENT]

[ROSTER]
Halia Thornton — late thirties, sharply dressed, runs the Miner's Exchange. Wants the
Redbrands gone but doesn't want to take the risk herself; long term wants to run Phandalin in
all but name. Secretly a Zhentarim agent.
[/ROSTER]
```

Nothing inside a bracket span is reinterpreted or reformatted — the raw prose the Editor wrote
is the entry's content, verbatim. No name field, no tags field, no per-kind field list. The UI
identifies an entry by its type plus an auto-truncated preview of its first line.

---

## Tag System

Tags are the primary mechanism connecting user posts to worldbook entries. LM's tagging is **user-curated**, not LLM-inferred.

Inference-based auto-tagging was evaluated and rejected. The results were unreliable and introduced errors into the retrieval pipeline. The user-curated approach trades automation for determinism — which is the right tradeoff here.

### How Tags Work

- Tags are pure grep/index constructs. There is no pointer from a tag to a worldbook entry or
  from an entry to a tag — a tag "belongs" to whatever content it happens to textually match,
  posts and worldbook entries alike (2026-07-03: an earlier design let the user manually point a
  tag at a specific entry; dropped in favor of matching everything the same way).
- A tag must be a single word, letters only, at least three characters (`/^[A-Za-z]{3,}$/`).
- Tags are maintained by the user in a tag cloud visible throughout the story phase.
- When a tag is added or edited, the back end performs a retroactive grep across all existing posts and worldbook entries and stores the resulting index (which content contains that tag).
- At prompt assembly time, this index drives two independent things: which archive blocks/compressed rows get promoted to verbose (matches against post/compressed content), and which non-CONTENT worldbook entries (ROSTER/MEMORY) get pulled into the prompt (matches against entry content). CONTENT entries are always injected regardless of tags.
- Tags whose match doesn't resolve to a worldbook entry are evaluated before tags that do, during prompt assembly. This prioritizes surface area (events, references) over known lore, since the lore is already in the worldbook.

### Tag Cloud Lifecycle

- **Setup phase:** The user creates tags as the worldbook takes shape. Tags are entirely
  user-created — the Editor never creates, edits, or points a tag at anything (2026-07-03).
- **Story phase:** Tags are live and visible. The user adds tags as new characters, locations, or concepts emerge. Low friction is a hard UI requirement here — tagging during play must be fast.
- **Post-edit:** Any tag change triggers a retroactive re-index of existing posts and worldbook entries.

---

## Agentic Prompting

LM has three agents, each with a distinct role and prompt strategy.

**Editor** — Conversational agent for setup and maintenance. Conducts "shop talk" with the user, writing plain prose that wraps anything worldbook-worthy in a bracket tag the back end detects deterministically (see Structured Schema) — not a tool call. Also used during kickoff to generate and iterate on the opening post.

**Author** — Story-phase agent. Receives worldbook entries (persistent and tag-triggered), the assembled log, and the user's latest post. Prompted to treat the user's input as describing the PC's actions — not as direct user commands. Responsible for all prose generation during play.

**Worker** — Background agent. Handles compression and archiving without editorializing. Prompted to return facts only, avoid redundancy with prior compressed history, and not revise or embellish. Has tooling for tag resolution including recursive lookup (a post mentions Halia → also retrieve Phandalin) and pronoun disambiguation (two uses of "her" in a post → resolve each to a specific character before tag lookup).

---

## Tool Use and MCP Server

LM makes deliberate use of model-side tool calling and exposes its own internals through an MCP server, for two distinct reasons.

### Tool Use (Internal)

Each agent's capabilities are implemented as discrete tools — functions with enforced inputs and outputs — rather than monolithic prompts. This keeps prompts scoped tightly to what's actually needed: pronoun disambiguation, for example, is only loaded into the Worker's context when a post actually contains ambiguous pronouns, not on every compression call. Tool use is what makes the three-agent architecture composable rather than each agent carrying one enormous catch-all prompt.

The Editor's worldbook authoring is a deliberate exception to this: an earlier design had the
Editor call a tool (e.g. `create_worldbook_entry`) mid-conversation, on its own judgment that
enough had been established to record. In practice this proved to be the least reliable part
of the whole tool-use approach — schema/field-casing drift and inconsistent completeness
across otherwise-identical conversations (see docs/stub-revisions.md's superseded entry) — so
it was replaced (2026-07-03) with plain bracket-tagged prose the back end parses
deterministically via regex, no tool call involved. Compression and archiving still depend on
real forced tool-calling (the Worker's `submit_summary`/`submit_archive_summary`), which has
been reliable throughout — the problem was specific to open-ended, judgment-call extraction,
not tool-calling as a mechanism. Phase 1 still requires the inference provider to support
native function calling as a baseline for the Worker's role; this remains one of the deciding
factors in scoping Phase 1 to Featherless alone (see Provider Abstraction).

### MCP Server (Developer-Facing)

LM's back end exposes an MCP server primarily so AI coding assistants working on LM itself — Cursor, Claude Code, or similar — can inspect live application state during a development session: recent logs, queue status, a story's worldbook or tag index, and similar. This addresses a concrete pain point: without it, debugging requires manually copying state out of the running instance and pasting it into a chat session. With it, a coding assistant can query the actual system directly.

This is a development convenience, not a means of opening LM to third-party MCP clients. Supporting external MCP servers as a consumer (LM calling out to other people's tools) is a future-phase idea with no concrete use case yet identified — it stays out of scope until one exists.

---

## Log Compression Pipeline

This is the core of LM's context management. Every post exists in up to three forms: verbose, compressed, and as part of an archive block.

### Forms

**Verbose** — The full text of the post as generated or entered. Always preserved.

**Compressed** — A factual distillation of the post (~20 tokens). Generated by the worker, deferred: a post becomes eligible for compression once it is five or more posts behind the current position. The worker uses the full log assembly technique up to that moment as context, with strong prompting to return only the facts of that specific post without redundancy.

**Archive block** — A narrative summary (~60 tokens) covering a sliding window of ten posts. Generated by the editor. A block is created whenever a complete set of ten valid, fully-compressed posts exists with no archive block yet assigned. This trigger is state-based, not position-based — it handles rewrites, undos, and branches correctly because it checks for the precondition rather than counting rows.

### Sliding Windows

Archive blocks use overlapping windows (e.g. posts 1–10, 6–15, 11–20) rather than fixed non-overlapping blocks. This prevents tagged events from being underrepresented by landing near the start of a block. Each post's "owner" block is determined by proximity to center: the block for which `abs(post_index - block_midpoint)` is smallest. Ties go to the more recent block.

Block size (ten posts) is a tunable parameter. Ten is appropriate for typical RP exchange pacing and produces a manageable compression ratio, but should be adjusted if story pacing changes significantly.

### Prompt Assembly

At the time of each author call, the back end assembles the prompt iteratively within a token budget:

1. Subtract maximum declared output length from the budget.
2. Subtract maximum declared reasoning length (may be zero — reasoning modes are not always beneficial for RP and must be togglable per agent).
3. Always include: core prompt, all CONTENT worldbook entries (in creation order).
4. Include all tag-triggered ROSTER/MEMORY worldbook entries.
5. Fill the most recent posts as verbose, up to 20% of the remaining budget.
6. Fill all remaining older posts as archive blocks.
7. Iterate from most recent to least recent archive block: if a block contains a tagged post, swap it for the individually compressed rows of that block, budget permitting. This is iterative to allow relative weighting. Tags without a matching worldbook entry evaluated before tags that have one.
8. Iterate from most recent to least recent compressed row: if a row is tagged, swap it for its verbose form, budget permitting. Same ordering rules apply.

The result: the most recent history is always verbose. Any history relevant to the current action is promoted as far toward verbose as the budget allows. Everything else degrades gracefully from compressed to archived.

---

## Story Flow

### 1. Setup

1. User initiates a new story.
2. The editor opens a structured conversation, asking what kind of story the user wants and probing for details.
3. As the conversation develops, the back end regex-scans the editor's OOC replies for bracket-tagged blocks and creates a worldbook entry per detected block, highlighted live in the chat. The tag cloud is user-maintained, not editor-populated. Both are presented to the user as a live preview beside the chat.
4. User clicks **Kickoff** on the live worldbook. The editor finalizes the worldbook and transitions to the kickoff phase.

### 2. Kickoff

1. The author generates an opening post based on the worldbook.
2. User feedback is treated as a guided retry. The opening post is shown as a live preview beside the chat.
3. User may click **Back to Setup** to return and adjust the worldbook.
4. User clicks **Approved**. Setup posts are hidden (not deleted).
5. The worker compresses each setup post and the kickoff post.
6. The editor archives the setup sequence (excluding the kickoff) as a single archive block.
7. The editor archives the kickoff post as its own archive block.
8. Story phase begins. The live worldbook and tag cloud remain visible.

### 3. Story

1. User submits a post.
2. The back end queues the request. **User input never goes directly to the provider** — it always creates a queue entry. The queue is processed and prioritized by the back end. This is a hard requirement to handle provider concurrency limits and avoid the bounce condition when a prior request hasn't actually been cancelled yet.
3. The assembled prompt is sent to the author via the queue.
4. The author's response is returned and displayed.
5. Once a post is five or more positions behind current, the worker queues a compression job for it.
6. Once a complete sliding window of ten fully-compressed posts exists without an archive block, the editor queues an archive job for it.

---

## Chat Interface Features

The following controls are available during story phase. All of them interact with the versioning, compression, and indexing pipeline — their behavior against that pipeline is documented alongside each control.

### Post Controls

**Retry** — Regenerate the last author post. The new response becomes a new version of that post. Prior versions are preserved until the post becomes eligible for compression (five or more posts behind current), at which point alternate versions are discarded and the canonical version is locked in.

**Guided retry** — Regenerate the last author post with a user-supplied direction. Logged and versioned identically to a standard retry. The guidance itself is not stored as a post.

**Continue** — Generate a continuation of the last post. Logged as a new post, not appended to the existing one. Subject to normal compression lifecycle from that position.

**Guided continue** — Continue with user-supplied direction. Logged as a new post identically to a standard continue.

**Undo / Redo** — Step backward and forward through post history one post at a time. Non-destructive. The log is not modified; the current position is moved. Compression and indexing operate on the canonical log regardless of where the user is currently viewing.

**Edit** — Modify the text of any existing post, user or author. The edited version becomes a new version of that post at its original log position. Versioning and compression lifecycle are identical to retry: alternate versions persist until compression eligibility, then the canonical version locks in. Tag indexing is re-evaluated against the edited content immediately on save — a retroactive grep pass runs against the edited post and updates the index.

### Branching and Rewind

**Branch** — Fork the story from any post. Creates a new save slot containing a full copy of the log up to and including the selected post, plus a snapshot of the worldbook version active at that moment. The branch is independent from that point forward — log and worldbook can diverge freely. Branch-of-branch is supported implicitly since every branch is a complete story state.

Branches are auto-named on creation (e.g. "Branch — Post 47 — 2026-03-15 14:32") and appear as first-class entries in Story > Saves. Rename is available inline in Saves. The original thread continues to exist as its own save slot and is unmodified by the branch operation.

**Rewind** — Destructive branch. Identical to Branch except the original thread is discarded from the fork point forward rather than preserved. Presented as a separate control from Branch to make the destructive intent explicit. A confirmation prompt is required before executing.

### Interaction With Compression and Indexing

These rules apply uniformly across all controls above:

- **Compression eligibility** is based on a post's position relative to the current end of the canonical log, not its creation timestamp. A post that gets un-rewound, re-edited, or moved by a branch re-enters the eligibility check fresh.
- **Compressed and archived forms are invalidated** when a post's canonical content changes (via edit or version lock-in). The worker re-queues compression for that post. Any archive block containing that post is likewise invalidated and re-queued once all its constituent posts are re-compressed.
- **Tag indexing** runs retroactively on any content change. An edited post, a newly canonical version, or a branch all trigger a grep pass against current tags for affected posts. The index is updated before the next prompt assembly.
- **Alternate versions** (from retries, guided retries, edits) are not indexed or compressed — only the current canonical version enters the pipeline. On version lock-in, non-canonical versions are deleted.

### Worldbook Versioning

Every change to a worldbook entry is stored as a versioned snapshot rather than an overwrite. The active worldbook version at any moment in the log is recoverable on demand.

This serves two purposes: it provides a rollback mechanism for rogue edits made during debugging or editor agent loops, and it ensures that Branch and Rewind capture an accurate worldbook state at the fork point rather than the current (potentially diverged) worldbook.

Worldbook version history is accessible from the Lore section. Restoring a prior version creates a new version entry — it does not delete the history between then and now.

---

## UI Structure

LM's interface is built around a consistent component language: a set of icon-sized atomic elements used uniformly across navigation, tabs, and controls. Every component — including structural elements like the input bar — is config-driven: its size, position, and grouping live in a per-user data structure rather than being hardcoded into markup. Component sizing uses relative/proportional units (percentages, flex/grid), not fixed pixel values.

Phase 1 implements this as a read-only, modular layout: the structure is fully component-based, but rearranging it is a configuration-file-level task, not a user-facing drag-and-drop interface. Phase 2 is expected to add a WYSIWYG layer that edits the same configuration data Phase 1 already reads from — so Phase 2 becomes a new way to write the config, not a rebuild of how components render. Layout configs are stored server-side per-user, support named save slots (parallel to preference profiles), and can be exported. Binding specific layout slots to device characteristics (orientation, screen size) and gracefully handling arbitrary window resizing are both explicitly deferred to Phase 2 — Phase 1 should simply avoid decisions (like fixed pixel values) that would make that harder later.

The interface must be viable on Android and Windows browsers without native app installation. Layout and interaction design should assume touch-first.

### Status Icon

A large icon in the top-right corner serves dual purpose: it is both a live status indicator and the primary navigation trigger. The icon overlays the text rather than forcing a sidebar.

As a status indicator, it reflects the current LM state — idle, queued, generating, error — and displays contextual information such as time remaining on an active task. This state must remain legible at a glance; the icon's visual design needs to communicate status without requiring the user to tap into it.

Tapping the icon expands or collapses the navigation menu. The four primary menu buttons appear at the same size as the status icon itself, vertically distributed on a half-transparency sidebar that occludes the text.

### Navigation Sections

Tapping a section button expands that section to occupy the main screen area. Tapping it again closes it. Tapping a different button closes the current section and opens the new one. Each section uses the same icon-sized tab components for sub-navigation.

The goal is that a user never needs to be in more than one section to accomplish a task. Lore and Story are the two sections in active use during play. Config is for pre-session tuning. Debug is for when something's wrong.

**Lore**
Two-column layout. The left column holds the Tags panel, always visible. The right column has four tabs: Memory, Worldbook, Compressed, and Archived. This gives the user a live view of the lore state at any point during play. Hidden elements are excluded from any assembled prompt; hiding a compressed line requeues the corresponding archive.
- *Tags* — tag management; create, edit, hide (toggle), delete (toggle), filter (toggle). Tags are a single word, letters only, at least three characters. Edit, hide, and delete toggles prompt a save button to lock in the change. The filter toggle acts as a filter on each of the right column's four tabs. With a tag filter active, the Memory tab generates its prompt as if the tag had been picked up in the user's input text; the Worldbook tab shows entries the tag's grep matched; the Compressed tab shows only entries indexed for the tag; the Archived tab shows only blocks covering compressed posts indexed for the tag. There's no separate "tagged" vs. "matches by text" distinction to show — a tag's relationship to an entry is always the grep match itself, nothing is stored on the entry.
- *Memory* — the assembled prompt inspector: shows the finalized prompt as it would be sent, with each component's source identified. The purpose is to explore the interactions of tags and compression/archives.
- *Worldbook* — worldbook management; create, edit, hide (toggle), delete. Entry type (CONTENT/ROSTER/MEMORY) is a discrete flag; content is freeform prose with no field schema to conform to or validate against.
- *Compressed* — compression management; edit, hide (toggle), requeue. Hydrates with the complete set of eligible index entries. Uncompressed but eligible rows are highlighted.
- *Archived* — archive management; edit, hide (toggle), requeue. Hydrates with blocks that cover the complete set of eligible index entries. Unarchived but eligible blocks are highlighted.

**Story**
Three tabs: Saves, Logs, and Summary.
- *Saves* — session/slot management; load, name, rename, and switch between active stories and branches.
- *Logs* — recent activity telemetry: timestamps, input text, observed tags, prompt text, response text, token counts, turnaround times, error codes. Input toggle state (length and mood) is included in this view as a part of the prompt assembly record.
- *Summary* — the rolling compressed log, most recent first: one dense line per post once compression has run on it. A read-only Phase 1 stand-in for the Compressed tab's full management (edit/hide/requeue) described under Lore below — Phase 1's flat tab bar (see UI Structure) has no Lore/Story section split yet, so this landed alongside Logs rather than there.

**Config**
Two tabs: Agents and Prompts.
- *Agents* — model and parameter selection per agent (Editor, Author, Worker). Controls for reasoning mode toggle and token budget per agent. Controls for concurrent thread counts allowed.
- *Prompts* — the prompt template for each element, exposed for direct editing. Not expected to be used frequently, but must not require SSH access. Any changes made to prompts are per-user and do not alter the defaults.

Config previously had a third tab, Preview, duplicating Lore > Memory's assembled-prompt inspector outside of play. Dropped (2026-07-03) as a redundant surface — Memory already covers the same need.

**Debug**
Live queue state and worker status. Distinct from Logs (which is historical) — Debug shows what's happening right now: what's queued, what's in flight, what's blocked, and why.

**Settings** (gear icon, not a primary section button)
Lower-frequency than the four primary sections. Contains:
- UI preference controls: dark/light mode, font size, spacing, padding, quoted speech color.
- Preference profiles: named snapshots of the full settings state (e.g. "wholesome slice of life", "grimdark"). Stored in user metadata, not per-story. Users can switch profiles to match their mood without any per-story tracking.

Existing market open-source implementations (SillyTavern, KoboldAI) are reference material for UI patterns and theme options — no need to reinvent these.

### Input Bar Toggles

The input bar is itself a layout component, like everything else described above — not a structural exception hardcoded outside the config-driven system.

Quick-access generation controls are surfaced via a single toggle-access button on the input bar (a "weapon wheel" pattern: tap to reveal the full set, tap a toggle to cycle it, dismiss to collapse). Phase 1 does not attempt to rank or pin individual toggles to the bar itself — all toggles live behind the access button uniformly. Promoting specific toggles to always-visible bar position is a Phase 2 refinement, once real usage shows which toggles are reached for most often. Where appropriate, the number of state options and their values are user-configurable in Settings.

**Length toggle** — cycles through requested output token counts. Three steps, defaults suggested at 100 / 300 / 500.

**Mood toggle** — cycles through named tonality macros. Each macro is a short user-defined instruction appended to the prompt (e.g. "write with more intensity, use visceral language" or "keep it light"). This replaces the pattern of guided retries used to adjust tone on the fly.

**Param toggle** — cycles through named parameter presets. Each preset includes one or more overrides for temperature, top p, top k, etc. The parameter defaults are controlled on the model level.

**Model toggle** — cycles through ranked-choice model selections.

**Effort toggle** — cycles through the presence and effort level of thinking/reasoning modes (when available for the selected model).

Toggles persist between posts until manually changed.

---

## Security

LM is a private tool for a small circle of known users. Security requirements are minimal but should be technically accurate.

**Encryption at rest (target model):** The original intent is for each user's story data to be encrypted using a key derived from their password, such that the operator genuinely cannot read story contents without the user's password. This remains the eventual goal but is explicitly deferred — see "current implementation" below for what's actually built during the multi-user milestone. Do not treat the gap between the two as an oversight to close opportunistically; full content/log encryption is a separate, larger effort than the multi-user milestone and stays out of scope until it's deliberately picked up.

**Encryption at rest (current implementation):** Provider API keys are encrypted at rest using a server-held symmetric key (AES-256-GCM), decrypted only in-process at the moment of the outbound provider call, and never returned through any UI — including to the operator's own admin view. This protects against casual/UI-level exposure, not against someone with SSH or root access to the host, who can read the server-held key like any other server secret; that gap is accepted, not a bug. Story content and logs are not encrypted at rest during this milestone.

Account access is controlled via password, not SSH credentials directly — each user gets a login (see Multi-User & Second Provider Milestone). Account *lifecycle* — creating, renaming, deleting a user, or resetting a forgotten password — remains SSH-only, run by the operator via a script, with no UI or API surface for any of it.

**User metadata** — name, inference provider, API keys, UI preferences, preference profiles, and similar — is stored per-user; only API keys are encrypted at rest during this milestone (see above). Password-derived encryption of the full metadata blob remains part of the deferred target model.

**Inference and queue state are not shared between users.** Each user individually asserts their own provider and API key.

**Session management:** Session access uses server-side tokens. A login issues a new token and invalidates any existing one for that user, evicting the prior session. An evicted session receives an explicit signal (not a silent failure) so the client can inform the user they've been logged in elsewhere. The intent is not strict security enforcement — it's avoiding the logistical problems of concurrent sessions: conflicting edits, stale caches overwriting recent state, and queue collisions. This mechanism is per-user as of the multi-user milestone — it does not evict other users' sessions, only a given user's own prior one.

**Primary keys:** UUIDs (v7) are used as primary keys throughout, including user records. Do not use sequential integer IDs for any user-facing or story-related records. Timestamps for logging and debugging are stored explicitly as separate fields — do not rely on the UUID's embedded timestamp for application-level logic.

This is not a substitute for real security practices — it is a trust model appropriate for the scale and audience of this project. **This phase's security scope is deliberately narrow.** The multi-user milestone's effort belongs in user/session/data-isolation plumbing and the Horde integration, both substantial on their own — do not expand security scope further this phase (full content encryption, hardened auth, rate limiting, etc.) without an explicit decision to do so.

---

## Provider Abstraction

Phase 1 targets Featherless exclusively. This is a deliberate sequencing choice, not an oversight: LM's value proposition is tool use and agentic orchestration (see Tool Use and MCP Server), and that needs to be proven out against one known-good provider before taking on the complexity of a provider abstraction layer. Featherless uses an OpenAI-compatible API — requests are submitted and a response is awaited on the same connection — and is confirmed to support the function-calling the Editor's setup flow depends on.

Featherless ($25/mo tier) provides unlimited usage and threading of smaller models, capped at 32k context regardless of model native limit, with four simultaneous connections. Larger models (Editor/Author) consume all four slots. This concurrency ceiling is the reason the queue (see Story Flow) is a hard requirement rather than an optimization — without it, simultaneous requests from multiple users would exceed what Featherless allows.

The provider module should still be written as its own component rather than inlined into agent logic, since that boundary will matter once a second provider is added — but Phase 1 does not need to design or commit to an abstraction interface ahead of having a second real provider to abstract against. Speculative abstraction here would be guessing at a shape based on no evidence.

Ranked-choice model selection (falling back to a second Featherless model if the first is unavailable, or hotswapping models for different needs) is in scope for Phase 1, since it operates within a single provider.

Multiple providers were originally planned as a deliberate Phase 2+ direction once Phase 1 proved out the tooling-first approach — that held until the multi-user milestone (see Multi-User & Second Provider Milestone) needed a second user's own local compute to be reachable without exposing their home network, which pulled the Horde forward specifically. Generic OpenAI-compatible endpoints and the wider range of providers remain deferred on their original timeline. The open question that motivated deferring this in the first place — how much of LM's tool-use dependency can be relaxed or routed around for providers that don't support native function calling (see Tool Use and MCP Server) — is now a live question for the Horde specifically, not just a future-phase abstraction. Existing market open-source implementations (SillyTavern, KoboldAI) are reference material for provider/model-specific endpoints, headers/bodies, internal prompt formatting, and tweaks.

---

## Multi-User & Second Provider Milestone

This is the next concrete build target: taking LM from a single implicit user to real multi-user support, and adding the Horde as a second inference provider. Two independent problems that happen to be scoped together because the second provider only matters once a second real user exists to use it.

**Login and account lifecycle.** The login screen is a Netflix-style row of profile slots, one per user. Creating, renaming, or deleting a user, and resetting a forgotten password, is operator-only and happens via an SSH-run script — there is no UI or API surface for any of it, deliberately, to keep that attack surface at zero. New users get the literal password "random" by default; changing it afterward is a normal in-app action.

**Per-user data isolation is file-level, not just column-level.** Each user's data lives in its own file/directory, addressed by their UUID — the same pattern already used for per-story isolation (see Infrastructure). This was chosen over relying solely on `user_id` filtering within shared tables for two reasons: it avoids SQLite single-writer contention between users, and it keeps the door open for encrypting a whole user's data as one unit later, which is a much simpler target than selectively-encrypted columns scattered across shared tables.

**Two providers, independently configured per user.** Featherless remains available as-is. The Horde (aihorde.net) is added as a second option — each user's row includes a Horde API key slot, defaulted to the anonymous key (`"0000000000"`) at account creation so the Horde works out of the box with zero setup, overridable with the user's own registered key if they want queue priority.

**The Horde is not a drop-in Featherless replacement — expect real differences, not bugs to fix:**
- No streaming. Featherless streams tokens as they generate; the Horde is async submit-then-poll only, so a Horde-backed reply appears as a single block once the job resolves, not progressively. This is confirmed, not a defect to chase.
- No account-wide concurrency signal. Featherless's queue gating leans on a real per-account concurrency feed (see Provider Abstraction); the Horde's capacity signal is per-request (`queue_position`, `wait_time`), so it needs its own dispatch/queue handling rather than reusing the existing slot system. Expect a genuinely separate queue path for Horde-backed jobs, not a shim over the existing one.
- Function-calling support is unconfirmed. The Worker role depends on real forced tool-calling (see Tool Use and MCP Server); whether the Horde's available text-generation workers/models support this reliably is an open question to verify before assuming compression/archiving works identically for Horde-backed stories.

**Explicitly deferred within this milestone:**
- Onboarding any specific user's own Horde worker (e.g. via KoboldCpp's built-in `--hordeconfig` mode). This milestone builds the Horde *client* integration in LM; getting a particular user's own hardware serving jobs on the Horde is a separate, later step once the client side works.
- Generic OpenAI-compatible endpoints (LM Studio, AnythingLLM, or similar). Considered and set aside — the Horde solves the actual problem (routing a user's local compute through LM without exposing their home network) without the tunneling/networking burden a direct connection would require.

See Security for what encryption scope does and does not cover during this milestone.

---

## Out of Scope (Phase 1)

- Multimedia: no image generation, no image consumption, no music, no TTS. Basic avatar art for display formatting is acceptable.
- Generic OpenAI-compatible endpoints (LM Studio, AnythingLLM, and others) and any provider beyond Featherless and the Horde. The Horde was pulled forward into the multi-user milestone (see Multi-User & Second Provider Milestone) as the answer for routing a user's own local compute; everything else stays deferred (see Provider Abstraction and Future Phases).

---

## Appendix: Future Phases

The following ideas are noted for future consideration. They are deliberately excluded from Phase 1 scope. A coding assistant should not act on these unless explicitly asked.

- **Additional providers** — Generic OpenAI-compatible endpoints and a wider range scraped from SillyTavern/KoboldAI provider lists (the Horde was pulled forward into the multi-user milestone — see Multi-User & Second Provider Milestone). Depends on resolving how much of LM's tool-use dependency can be relaxed for providers without native function calling. Some providers will not tolerate ERP content; rather than filtering them out, surface this as a visible flag/toggle (e.g. "this provider works for PG content only") so the user makes an informed choice.
- **Iconographic / app-style interface** — A more visually rich UI layer on top of the current functional interface.
- **Pronoun declarations per tag** — Each tag explicitly declares associated pronouns to improve worker disambiguation accuracy.
- **Worldbook deltas** — Story-state changes to character or location entries are stored as deltas separate from the canonical entry, preventing story events from contaminating the baseline worldbook.
- **Creature entry emphasis mode** — Tooling to help users decide when a creature entry is warranted versus relying on the LLM's baseline knowledge.
- **WYSIWYG layout editing** — A drag-and-drop interface for editing the per-user layout configuration that Phase 1 already reads from. Includes device-aware layout binding (orientation, screen size) and graceful handling of arbitrary window resizing.
- **Outside MCP client support** — LM consuming tools from third-party MCP servers. No concrete use case identified yet; revisit if one emerges.

---

## Current State

A GCP e2-micro VM is stood up with a KoboldAI Lite install and a SQLite back end with custom injections and overrides. It is functional but awkward — KAI's Horde service assumptions create friction, and several intended features (guided continue, proper queue management) don't exist in that setup.

The working conclusion is that hijacking KAI is not the right path. LM should be a purpose-built client. Artifacts from the KAI setup and prior SillyTavern character card experiments are available as reference material and can be shared into a development session on request.

When beginning a development session, the coding assistant should request any relevant artifacts before proposing an implementation approach.
