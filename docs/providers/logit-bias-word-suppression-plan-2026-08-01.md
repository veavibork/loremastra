# `logit_bias` word suppression — design plan (2026-08-01)

**Status: design only, not started.** Paused after the investigation below to prioritize further
story-to-date fold/segment stress testing. Pick this back up as its own project — this doc is the
handoff.

**Prerequisite reading:** [featherless-notes.md](featherless-notes.md)'s "Correction (2026-08-01):
`logit_bias` is honored" section — that's the evidence this plan is built on. Read that before this;
it explains why the 2026-07-02 "no path to token-level control" conclusion no longer holds.

## What's proven

1. `logit_bias` has a real, measurable effect on `/v1/chat/completions` (this app's actual endpoint
   — no chat-template rework needed) for at least `zai-org/GLM-5.2`. Confirmed via a wide-range
   stress ban (not representative of real use, but decisive) and via precise single/multi-token bans
   on a forced test phrase.
2. **Unreconciled contradiction, flag before resuming:** this bullet originally claimed real
   tokenizers for both `zai-org/GLM-5.2` and `moonshotai/Kimi-K2.7-Code` were downloadable from
   HuggingFace (`tokenizer.json` for GLM; a `tiktoken.model` + custom `tokenization_kimi.py` for
   Kimi). `featherless-notes.md`'s 2026-08-01 correction section — which this doc calls
   "prerequisite reading" — states the opposite for Kimi: HF repo lookups for these exact model
   ids **404'd** (`moonshotai/Kimi-K2.5`, `moonshotai/Kimi-K2.7-Code` both tried; likely a
   private/gated repo or a Featherless-internal naming convention with no 1:1 public HF mapping).
   These can't both be true as written. GLM-5.2's tokenizer access is solidly confirmed either
   way (real token ids used throughout the findings below); **re-verify the Kimi-K2.7-Code claim
   from scratch before relying on it** — don't assume either doc is the correct one without
   re-running the lookup. `/v1/tokenize` remains useless for this regardless (count only,
   re-confirmed).
3. **A word needs its full variant set banned to reliably suppress it, not just one spelling.**
   Demonstrated on "Patricia" against GLM-5.2's real tokenizer:

   | Bias applied                                                                                   | Output                                                                                                                 |
   | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
   | none                                                                                           | "Lex slaps **Patricia** with a fish"                                                                                   |
   | ban only the fused `" Patricia"` token (id 53575)                                              | "Lex slaps\n**Patricia** with\na fish" — model reroutes via a newline + different tokenization, word survives          |
   | ban `{53575, 44923}` (fused form + shared "ricia" tail, present in every multi-token spelling) | "Lex slaps **patrician** with a fish" — word suppressed, but the model substitutes a phonetically-adjacent _real word_ |
   | ban all 5 variants found (fused, bare two-piece, lowercase two-piece, ×leading-space)          | "Lex slaps **Patty** with a fish" — full suppression, graceful semantic substitution, zero breakage                    |

   This is the target behavior: comprehensive-enough coverage makes the model paraphrase around the
   forbidden word instead of degrading into repetition/garbage (which is what happens if you ban an
   enormous, non-targeted swath of the vocabulary instead — see the stress-test evidence in
   featherless-notes.md; not representative of a normal handful-of-words ban).

## What "for real" requires

### 1. A pure-JS/WASM tokenizer, not a Python dependency

This investigation used Python + `huggingface_hub` + `tokenizers` as a research scratchpad — fine
for a one-off probe, wrong for production. This app is Node/TS end to end with no Python in its
_runtime/production_ stack or GCP deployment story (see `docs/gcp-deployment.md`) — the repo does
contain a small dev-only Python toolkit (`src/inference/schema/parse.py`,
`extract-tool-call-code.py`, a manual curl+Python API-verification kit, see
`src/inference/schema/README.md`), but nothing Python-based ships or runs in production. Adding
Python as a runtime
dependency just for this would be a real, ongoing deployment burden (VM provisioning, pip installs,
version drift) for a feature that doesn't need it. HuggingFace's `tokenizers` library ships real
Node bindings (NAPI, no WASM-in-browser complexity) that load the identical `tokenizer.json` files
used above. That's the correct implementation target. Confirm it can load at least one of this
project's actual candidate models' tokenizer files before committing to the approach.

### 2. A resolver module

Two responsibilities, likely one module (`src/inference/token-ban-resolver.ts` or similar):

- **Tokenizer fetch + cache.** Given a Featherless model id, download its `tokenizer.json` from the
  matching HF repo (so far, Featherless model ids have mapped 1:1 to public HF repo ids — not yet
  verified this holds universally) and cache it to disk (e.g. under `data/tokenizers/<model-id>/`),
  keyed by model id. Refresh only if the configured model changes.
- **Word → token-id set.** Given a target word/phrase, generate the variant set (bare, leading-space,
  capitalized × both, lowercase × both — extend if evidence shows more variants matter, e.g.
  newline-prefixed forms) and encode each with the loaded tokenizer, unioning the resulting ids.
  Cache `(model id, word) → ids` — this is the expensive-ish step, and it only needs to run once per
  pair, not per request. A model swap invalidates the cache for that model (ids are tokenizer-specific,
  not portable across models).

### 3. A fallback path for models without a public tokenizer

Some models on Featherless will be gated or won't have a resolvable HF repo (GLM-5.2's was solidly
confirmed public; Kimi-K2.7-Code's status is exactly the unreconciled contradiction flagged above —
resolve that first, since it may already be a live example of this exact case).
Needs a defined degraded behavior: skip banning silently and log it, surface a warning in the Agents
UI ("word suppression unavailable for this model"), or fall back to the existing hard-stop behavior
for that specific word. Silent-and-logged is probably right — a missing nice-to-have shouldn't block
generation — but worth a real decision, not a default-by-accident.

### 4. Config surface

A per-role "words/phrases to suppress" list. This is the original motivation behind the
now-narrowed banned-phrase feature — originally `src/services/stop-list.ts`
(`docs/providers/featherless-notes.md`'s 2026-07-02 decision), but that file was itself replaced
the same day: the current mechanism is `src/services/refusal-detection.ts`'s `matchesRefusalPrefix`
reading from a `banned-phrases` settings-space entry, scoped narrowly to Worker/Editor
compress/archive jobs only (deliberately _not_ applied to Author prose or Editor setup replies —
see that file's docstring). Now that word-level suppression might be achievable, decide: extend
the `banned-phrases` settings space with a second mode (suppress vs. the current prefix-detect/fail
behavior), or ship this as a distinct, new setting entirely — and whether it should stay scoped to
compress/archive or extend to prose. Recommend reusing the existing UI surface if the semantics
don't get confusing to a user configuring both modes at once — a fresh decision to make when this
project resumes, not answered here.

### 5. Scope check before generalizing

Everything above is confirmed on `zai-org/GLM-5.2` only. Before assuming it applies broadly:

- Re-run the same forced-phrase test against `moonshotai/Kimi-K3` (the Author model in use as of
  this writing per the user's own account — note the hardcoded fallback in `src/config.ts` is
  `deepseek-ai/DeepSeek-V4-Pro`; the live Config > Agents setting is a per-user DB override not
  visible from source, so confirm the actual current Author model before re-running this) —
  confirm `logit_bias` has a real effect on its `/v1/chat/completions` output too, not just GLM's.
- Confirm Kimi's tokenizer (`tiktoken.model` + custom Python tokenization code, not a plain
  `tokenizer.json`) is actually loadable via the Node tokenizer library chosen in step 1 — its
  loading path is different from GLM's and may need separate handling, or may not be supported by
  a pure-JS loader at all (worth checking early, since it'd change the fallback story above from
  "rare edge case" to "the Author model itself needs the fallback path").
- Re-verify the original 2026-07-02 "no effect" finding wasn't actually correct for whatever model
  that test used — if it turns out some models genuinely don't honor `logit_bias` even on
  `/v1/chat/completions`, the per-model fallback path (point 3) needs to cover that too, not just
  "tokenizer unavailable."

## Non-goals for this plan

- **Not** switching any call off `/v1/chat/completions` — ruled out explicitly; the chat endpoint
  already works, this plan only concerns getting real token ids for it.
- **Not** a general-purpose tokenizer service for other features — scoped to word-suppression only
  unless a second consumer shows up.
- **Not** touching the fold/story-to-date work from the same session (`selectFoldBatch` fix,
  `looksLikeMidSceneEnding`, the checklist-scaffold experiment, GLM-5.2 editor-model findings) — see
  [editor-model-eval-methodology-2026-08-01.md](editor-model-eval-methodology-2026-08-01.md) for
  that thread; it's independent of this one and already shipped.

## Reusable artifacts from this investigation

None checked in — every script used to reach the findings above (`tmp-logit-bias-*.ts`,
`tmp-find-token-id.ts`, `tmp-verify-*-ban.ts`, the Python tokenizer probes) was scratch work, deleted
after use. Re-derive from this doc rather than looking for them; the useful output is the findings
table above and the four numbered requirements, not the throwaway probe code.
