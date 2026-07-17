# Reasoning / thinking stream research (2026-07-04)

Empirical notes from probing Featherless `deepseek-ai/DeepSeek-V4-Pro` — do not assume OpenAI-compat
field names or SillyTavern/KAI behavior without re-probing on the actual provider.

**Related:** [featherless-notes.md](featherless-notes.md) (API quirks), [development.md](../development.md)
(milestone history), [model-shape-probe-2026-07-17.md](model-shape-probe-2026-07-17.md) (supersedes
the routing mechanism below).

> **Superseded 2026-07-17.** `looksLikeLeakedReasoningArtifact`, `proseStreamUsesReasoningTrace`, and
> the peek-buffer machinery described below (`emitReasoningAsAnswer`, `REASONING_LEAK_PEEK_CHARS`)
> were removed. Kimi-K2.7-Code's reasoning was leaking into visible prose the same way DeepSeek's
> once did, but its reasoning text doesn't match the `article`-prefix signature this fix was built
> from — proving the signature-based approach never generalized past the one model it was written
> for. Trace routing is now shape-based instead: any reasoning-field or `<think>`-tagged content
> always goes to the trace channel, for any model, no signature-matching or name-gating involved.
> See [model-shape-probe-2026-07-17.md](model-shape-probe-2026-07-17.md) for the evidence and the
> new design. The rest of this document is kept as the historical record of how the old mechanism
> was diagnosed and built — still useful context, no longer current behavior.

## Probe scripts

| Script                                 | Purpose                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `scripts/probe-deepseek-raw.ts`        | Raw SSE dump — every delta key, no assumptions                            |
| `scripts/summarize-raw-stream.ts`      | Neutral stats on a raw jsonl file                                         |
| `scripts/probe-thinking-kwargs.ts`     | Matrix of `enable_thinking` / `thinking_budget` / prefill (simple prompt) |
| `scripts/probe-thinking-production.ts` | Same matrix on a **production-scale** Author prompt (~18.7k tokens)       |

Production prompt source: latest `streamInference` entry in VM `data/outbound-requests.log`, or
`assembleAuthorPrompt()` for story `019f25e0-…` (falls back if local DB incomplete).

Artifacts: `data/experiments/thinking-kwargs/*.json`, `data/experiments/deepseek-raw/*.jsonl`.

## Featherless V4-Pro stream shape (confirmed)

With **thinking enabled + prefill** (`<think>\n`):

1. SSE comment `: FEATHERLESS PROCESSING`
2. **`delta.reasoning`** chunks (meta planning or prose-like drafts — non-deterministic at temp 1)
3. **`delta.content`** chunks (IC prose)
4. Stop: `delta.reasoning: null`; `usage.completion_tokens_details.reasoning_tokens` counts toward
   shared `max_tokens` budget

Not observed on Featherless V4-Pro: XML `<think>` tags in streamed text;
`reasoning_content` is always null (use **`delta.reasoning`**).

## `chat_template_kwargs` matrix (simple prompt, max_tokens=500)

| Prefill | enable_thinking | thinking_budget | Reasoning channel | Content | We retry?     |
| ------- | --------------- | --------------- | ----------------- | ------- | ------------- |
| ✓       | _(none)_        | —               | meta (~378c)      | IC      | No            |
| ✓       | **false**       | —               | **IC prose only** | **0**   | **Yes** ← bug |
| ✗       | false           | —               | 0                 | IC      | No            |
| ✓       | —               | 100             | 0                 | IC      | No            |
| ✓       | true            | 100             | 0                 | IC      | No            |
| ✓       | false           | 100             | 0                 | IC      | No            |

## Production prompt results (2026-07-04, ~18.7k prompt tokens)

| Case                                 | Result                                                              |
| ------------------------------------ | ------------------------------------------------------------------- |
| **enable_thinking: false + prefill** | **RETRY** — 1000 chars IC in `delta.reasoning` only                 |
| **thinking_budget: 100**             | Wall timeout (300s) on prod prompt — hung (works on simple prompt)  |
| **baseline prefill**                 | OK — reasoning (2072c, mixed meta/prose) → content (1086c)          |
| **enable_thinking: true ×3**         | All OK — meta or mixed reasoning → content; non-deterministic style |

**Hermes-3-8B (worker):** never emits `delta.reasoning`; `enable_thinking` is a no-op for stream
shape. Forced prefill causes chat-template token leak into IC — do not prefill non-reasoning models.

## Fixes shipped (2026-07-04)

1. **Retry trace reset** (`publishStreamReset`) — internal retries no longer stack reasoning drafts in
   the UI (`21d33d7`).
2. **Effort-aware prose stream** (`proseStreamUsesReasoningTrace`, `shouldPrefillReasoning` in
   `featherless.ts`; wired in `pipeline-runner.ts`):
   - **Effort Off** (`enable_thinking: false`): no prefill; `delta.reasoning` → prose bubble (not
     trace); 90s idle timeout; no false “reasoning but no answer content” retry.
   - **Effort On / default** on DeepSeek: prefill + reasoning trace; reasoning-only completion still
     retries (model sometimes never opens `delta.content` before budget exhaustion).
3. **Parser:** forward `delta.reasoning` and `delta.reasoning_content` to SSE `thinking` events.

## Future: per-model stream-shape confirmation

**Problem:** `isReasoningModel()` is currently a substring check on model id (`/deepseek/i`). New
models or providers need empirical confirmation before we prefill, show traces, or apply retry rules.

**Planned workflow (not built yet):**

1. **Catalog lookup** — given a HuggingFace model id, fetch card metadata (tags, architecture hints).
   Starter: `scripts/sync-hf-model-tags.ts` → `src/data/hf-model-tags.json` (offline cache, no runtime
   HF calls).
2. **Provider probe** — given `(model_id, provider)` (Featherless, Horde, …), run a minimal streaming
   completion with the same knobs production uses (prefill on/off, `chat_template_kwargs`), record
   which delta keys appear (`reasoning`, `reasoning_content`, `content`), and whether thinking-only
   completions occur.
3. **Register behavior** — store probe result per `(provider, model_id)` so `proseStreamUsesReasoningTrace`
   and parsers can be data-driven instead of hardcoded.

Until that exists, run `probe-thinking-kwargs.ts` / `probe-thinking-production.ts` manually when
adding a new Author model or switching providers.

## Confirmed bug (2026-07-05): Effort-Off routes genuine reasoning into stored prose

Reported symptoms: word-salad-looking text in Author replies, reasoning-sounding commentary
showing up as if it were IC prose, and a stray word ("article", initially misheard/misremembered
as "archive") prepended before it. Diagnosed from real production data on the VM (story
`019f25e0-219c-7189-b481-9f389a9a3c39`), not synthetic probes — `scripts/remote-log-skim.mjs` was
extended to dump recent `prose` job replies (`text.gen_package`) across all story DBs for manual
review.

**Root cause:** the 2026-07-04 Effort-Off fix (`proseStreamUsesReasoningTrace` returning `false`
when `chat_template_kwargs.enable_thinking === false`) assumed that on Effort Off, _all_ of
`delta.reasoning` is actually misrouted IC prose, so `streamWithFallback`'s `emitReasoningDelta`
(`src/queue/pipeline-runner.ts`) unconditionally sends it to `emitAnswer` instead of
`emitThinking` in that mode. That assumption is only sometimes true. Confirmed live: with Effort
Off and no prefill, DeepSeek-V4-Pro intermittently (non-deterministic at temp 1, same as the
already-documented reasoning-phase non-determinism above) opens with a **genuine planning/meta
paragraph** in `delta.reasoning` before switching to real IC prose in `delta.content` — and
because Effort Off treats every `delta.reasoning` chunk as prose, that meta paragraph gets
prepended straight into the stored reply.

Three real examples from one session (2026-07-05, ~21:44–21:54 UTC), all `toggles.effort.enableThinking: false`:

- Job `019f343d-83f2-74f9-b1c1-a3dbda15d169` — stored reply, in full: `article\nOkay, I need to
continue this story from where it left off. The user wants me to write in the same erotic pulp
fantasy style, with punchy prose, continuing the` — this one is also `truncated: true` (the user
  hit Stop while the model was still inside the leaked reasoning ramble; the "commit partial
  streamed content when stopping mid-generation" feature (`4021006`) then saved that raw
  meta-commentary as if it were a real partial reply).
- Job `019f343e-a81f-718b-9e8b-d0e8653200c6` — stored reply starts ` articleWell, this is a rich
moment. Lex just named the core dynamic—the bar is incredibly low...` (a full paragraph of
  scene-planning commentary), then transitions mid-string into actual IC dialogue (`"The bar is in
hell," Sloane agreed...`) with no separator.
- Job `019f3446-4130-7383-8964-ffe445dc8b56` — stored reply starts mid-sentence, ` phrase "using
every part of the deer" first—which turns it into a restaurant metaphor...`, i.e. the tail end of
  a reasoning paragraph whose opening got cut off by the splitter's tag-hold logic, followed by
  more planning prose, then the real IC scene.

Not every Effort-Off job in the same session showed this — several adjacent ones streamed clean
IC prose from the first token with no leaked commentary, consistent with the existing "skips
reasoning entirely or emits it" non-determinism note below. All Effort-On (`enableThinking: true`)
jobs in the same window were clean (reasoning correctly routed to the trace, not the stored
reply), which further isolates this to the Effort-Off code path specifically.

**Not the original theory:** this is not a token-ID or byte-boundary misattribution in the SSE
parser — `delta.reasoning` and `delta.content` remain cleanly separate fields at the transport
level (per the existing raw-capture evidence above), and `TextDecoder`/UTF-8 chunk handling in
`streamInference` is correct. The bug is a **routing policy** one: Effort Off can't safely assume
`delta.reasoning` is always misplaced prose. Fixing the "reasoning but no answer content" false
retries (the 2026-07-04 motivation for this routing) needs a design that can tell genuine
reasoning apart from misrouted prose in that channel — e.g. detecting whether the text reads as
IC narration vs. first/second-person meta-commentary about the writing task — rather than treating
the whole channel as one or the other unconditionally.

**Fixed 2026-07-05** (see the follow-up section immediately below for the full evidence this fix
is based on): `looksLikeLeakedReasoningArtifact()` (`src/inference/featherless.ts`) flags the
specific known-bad signature — every confirmed-bad reply starts with a literal `article` token, no
exceptions found, never seen leading a clean reply. `streamWithFallback` (`src/queue/pipeline-runner.ts`)
now holds back the first `REASONING_LEAK_PEEK_CHARS` (16) of any Effort-Off `delta.reasoning`
content in a local peek buffer before ever calling `emitAnswer` — long enough to test the
signature, short enough that nothing bad reaches `publishToken`/the stored reply. A match rejects
the whole attempt through the same retry path already used for empty completions
(`EMPTY_COMPLETION_ATTEMPTS_PER_CANDIDATE`, currently 2 attempts before falling to the next
fallback model), rather than showing or storing any of it. This is a narrow, signature-based fix,
not a general "detect any bad model output" classifier — see the follow-up section for why that
was the deliberate choice over trying to salvage/distinguish content mid-stream.

## Follow-up (2026-07-05): the "article" artifact and genuine word salad, both explained

Broadened the search past the two examples above — `scripts/search-word-salad.mjs` (ad hoc,
scratchpad only, not checked in) grepped every text-bearing column (`text.gen_package`,
`text.gen_extract`, `archive.summary`/`.name`, `story_to_date_segment.content`/`.name`) across all
8 story DBs for the literal word "article" and the two garbled fragments the user separately
flagged from memory ("frightened strongly tenets Layer", "drop pitfalls backward forward
extract"). Both garbled fragments were located; both were inside `article`-prefixed replies
already in the flagged set. Total: **13 genuine hits, all `job_type: prose`, all
`model: deepseek-ai/DeepSeek-V4-Pro`, all `toggles.effort.enableThinking: false`, no exceptions**
(a 14th hit was a false positive — the word "article" used legitimately mid-sentence in otherwise
normal prose, e.g. "...evangelical guilt' article—", easy to tell apart from the pattern below by
its position and grammar). 11 of the 13 are `truncated: true` (committed via user Stop, per
`4021006`'s partial-content-on-stop feature) — this matches "I tend to delete them": the ones that
ran to completion mostly self-corrected into real prose after the leaked opening (see the three
examples above), while the ones the user caught early and stopped are the ones that read as pure
gibberish, because stopping preserved the mid-collapse text verbatim instead of what would have
followed if the model recovered.

**The `article` token is a fixed, load-bearing signal, not noise.** It is the literal first thing
in every one of the 13 stored replies — sometimes lowercase and glued directly onto the next word
with no space or punctuation (`articleWell,`, `articleCircle`), sometimes capitalized and given its
own sentence (`Article: another blur_different step...`, `Article downloaded; reading with these
guidelines...`). The no-space gluing in particular (a real word boundary would almost always start
the next token with a leading space in this tokenizer family) reads like a special/control token
whose text surface form happens to be "article" — consistent with a leaked internal channel or
role marker (the way some other providers' chat templates expose named channels, e.g.
"analysis"/"final") that Featherless doesn't strip before forwarding `delta.reasoning` when
`enable_thinking: false` and no prefill is sent. Content quality _inside_ that channel then ranges
across the full spectrum seen in the 13 examples: coherent English meta-commentary ("Okay, I need
to continue this story from where it left off..."), degrading mid-stream into fragments ("Sharp
call map output rearrange picks drop pitfalls backward forward extract Next they tighter"), all
the way to complete multilingual token salad (Korean, Nepali, Portuguese, Russian, Chinese
fragments, and an emoji, all in one reply: "Circle 인해izards cycle Stephenitu wisdomccionesाउने
trabalhoeler anne concern..."). The two strings the user specifically remembered
("frightened strongly tenets Layer", "drop pitfalls backward forward extract") are both from this
degenerate end of the spectrum, inside `article`-prefixed replies.

**Assessment:** this looks like a Featherless/DeepSeek-V4-Pro serving-side issue specific to the
`enable_thinking: false`, no-prefill code path — not a bug in our SSE parsing (still confirmed
correct) and not obviously a prompt-construction leak either (a prompt leak would echo back
whatever the current worldbook/story-to-date/context text actually says, not a fixed word
independent of story content or session). Could not get a live raw-SSE capture to fully confirm
this at the wire level this session — the shared Featherless account was pinned at
`used_cost: 4/4` (checked via `GET /account/concurrency`) by the user's own active testing the
whole time, leaving no concurrency headroom for a probe request. Re-run
`PROBE_ONLY=enable_thinking_false_no_prefill npx tsx scripts/probe-thinking-kwargs.ts` next time
the account is idle to get a definitive raw capture of the token boundary around `article`.

**Practical takeaway either way:** whether `article` turns out to be a leaked template token or
something else provider-side, our own code's actual bug is unchanged from the section above —
Effort Off currently trusts 100% of `delta.reasoning` as displayable/storable prose, and that
channel is demonstrably unreliable. The fix (separate follow-up, not yet scoped in detail) needs
Effort Off to stop treating that channel as automatically safe to show/store — at minimum, refuse
to commit a reply that starts with this signature (leading `article`/`Article` token glued to
non-prose-looking text) instead of accepting it as a valid "done" completion.

## Investigated, not confirmed (2026-07-05): toggling Effort between retries of the same post

User's separate suspicion: generating a post in one Effort mode, then flipping the toggle and
retrying the _same_ post, might carry stale instructions/state from one mode into the other.
Traced the full plumbing on both sides — found no shared-state mechanism that would cause this:

- Server: `POST /:id/posts/:pageId/retry` (`src/routes/stories.ts`) creates a brand-new job with
  its own id, and `setJobGenerationOptions(job.id, body.generationOptions)`
  (`src/queue/pipeline-runner.ts`) stores that job's toggle snapshot in an in-memory
  `Map<jobId, GenerationOptions>`, read once and deleted at dispatch time. Nothing here reuses or
  falls back to a previous job's or previous text version's toggle state.
- Client: `toggles.generationOptions()` (`web/src/components/StoryToggles.tsx`) is a `useCallback` keyed off
  live `indices.effort` state, called fresh at click time by the retry/continue/send handlers in
  `web/src/views/StoryView.tsx` — not a value captured earlier and passed around stale.

No evidence of the specific mechanism found, but this wasn't tested end-to-end in a live
browser (only traced statically), so a click-timing race isn't fully ruled out. Likely, per the
user's own framing, an artifact of rapid manual toggling while chasing the Effort-Off bug above
rather than a separate real bug — but if it recurs with a concrete before/after example (which
toggle state, which job ids), worth a second look with that in hand.

## Open questions

- **`thinking_budget: 100`** suppresses reasoning on simple prompts but ** hung** on production prompt
  (300s, no tokens) — treat as experimental; do not expose as default Effort preset until understood.
- **Non-determinism at temp 1:** same config can skip reasoning entirely or emit long prose-like
  reasoning drafts; retry stacking made this look like “five full IC variations” before trace reset.
- **Context limit:** full `assembleAuthorPrompt()` can exceed Featherless 32k on long stories; production
  outbound log captures what actually fit at send time.
