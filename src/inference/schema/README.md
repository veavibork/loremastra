# Raw API verification toolkit (Featherless / any OpenAI-compatible provider)

Deterministic curl tests + a tiny SSE parser for figuring out how a provider _actually_ behaves
(reasoning field name, tool-call integrity, effort control) instead of trusting docs or hearsay.
No LLM prompt magic — the "prompts" here are just test fixtures designed to force specific behaviors.

## Quick start

```bash
KEY=your_featherless_key
API=https://api.featherless.ai/v1/chat/completions
# 1. replace MODEL_ID_HERE in the req-*.json files
# 2. run a test, save raw SSE
curl -sN --max-time 280 $API -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d @req-toolcall.json > stream1.txt
# 3. analyze
python3 parse.py stream1.txt
```

`parse.py` reconstructs tool-call args from the streamed deltas and prints:
finish_reason / reasoning chars (and which field they arrived in) / tool-call IDs (+ duplicate detection) /
whether each tool's args are VALID JSON. Corruption shows up as INVALID JSON or tag fragments inside values.

## How the test prompts are designed (the "prompt engineering" part)

Each request's user message forces one specific, deterministic behavior so a failure is unambiguous:

- **req-toolcall.json** — "write a ~100-line Python file via the tool, call it exactly once".
  Long args maximize the chance of mid-stream corruption; "exactly once" removes ambiguity;
  deterministic content (a shapes.py spec) makes runs comparable.
- **req-multitool.json** — "get weather for Tokyo AND Osaka, call the tool twice in this single turn".
  Two calls in one turn is the minimal repro for duplicate-tool-call-ID bugs (`call_0` everywhere).

## Full test matrix (what each variation reveals)

| Test                                        | Change from baseline              | Reveals                                                            |
| ------------------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| long tool args                              | ~100-line file write              | mid-stream arg corruption / tag leakage                            |
| two tool calls, one turn                    | multitool prompt                  | tool-call ID uniqueness                                            |
| `reasoning_effort: high/max/low`            | add param, non-stream             | which effort levels the host accepts                               |
| zai-style `thinking: {...}` vs nothing      | swap/remove param                 | which thinking control actually works (vs silently ignored)        |
| non-stream math question                    | no tools                          | which field carries reasoning (`reasoning` vs `reasoning_content`) |
| tool-result round trip, no reasoning replay | hand-built assistant+tool history | whether the endpoint validates replayed reasoning                  |
| forced `tool_choice` (named) + reasoning    | add both params                   | whether forced tool choice 400s or conflicts with reasoning        |

## Instructions for running this via a coding agent

If you drive this with an AI agent (Claude Code, omp, etc.), this is the instruction block I use:

> Verify model compat for MODEL_ID on PROVIDER_URL empirically. For each test in the matrix:
> build the request JSON, send it with curl (save raw SSE to a file), then analyze with parse.py.
> Run tests SEQUENTIALLY (big models eat 4 concurrency units; parallel tests just 429 — on 429
> wait 45s and retry). Never conclude from a single run: any "feature doesn't work" finding needs
> n>=2 plus a control condition. Record every request+response file; they are the evidence.
> Map observations to client config only after all tests pass twice.

## Gotchas (learned the hard way)

- Providers change deployments without notice — re-run after any announced backend change
- Vendor docs and community posts may describe a _different_ deployment (e.g. Z.AI's own API uses
  `reasoning_content`; Featherless serves the same model returning `reasoning`)
- A single empty-reasoning response fooled me once; n=2 + control showed reasoning was simply on by default
