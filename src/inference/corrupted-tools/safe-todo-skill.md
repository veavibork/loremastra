# safe-todo — omp workaround for GLM tool-call argument corruption

> The omp skill I use as a stopgap: route multi-param tool calls through the Python eval kernel,
> so there's no parameter boundary left for the XML→JSON parsing to break.
> (English translation of my working notes — originals are in Japanese.)

## Root cause (as far as I can tell — not "an omp bug")

GLM-family models emit tool calls as XML (`<arg_key>k</arg_key><arg_value>v</arg_value>` pairs) and the
**serving side** (vLLM's GLM tool parser) converts that to JSON. When that conversion intermittently fails
to split at a tag boundary, tag fragments leak into argument values:

```json
{"op": "done</arg_key><arg_key>task</arg_key><arg_value>git status & check recent commits", "i": "..."}
```

- The broken boundary is **always between parameters** → single-param tools are structurally immune
- Intermittent (measured 2026-07-10: 41 of 190 calls, clean and corrupted interleaved in the same window).
  Not reproducible with standalone curl — seems to need many tools defined + long context
- The client (omp) is just the receiver of the corrupted values; it can't fix this on its side

## Why the workaround works

The eval (Python kernel) tool `tool.<name>()` passes arguments as a Python dict. The model only writes
**one** XML parameter (the `code` string), so there is no tag boundary to split incorrectly.

## When to apply

| Condition | Action |
|---|---|
| omp + GLM-family model + multi-param tool (todo's op+task etc.) | **default to eval-wrapped calls** |
| Saw corruption (validation error / `arg_key` fragments) even once | eval-wrapped for the rest of the session, always |
| Single-param tools (bash, read) | call directly, they're fine |
| Non-GLM models (DeepSeek etc.) | no corruption seen so far; call directly |

## Usage

Do all todo operations via eval (py). Batch multiple ops into ONE eval call, and keep eval's own
params minimal (`language` + `code` only — skip `title`):

```python
result = tool.todo({"op": "done", "phase": "A: git context"})
print(result["text"][:200])
result = tool.todo({"op": "done", "task": "wrap-up"})
print(result["text"][:200])
```

| Operation | Call inside eval |
|---|---|
| init | `tool.todo({"op": "init", "list": [{"phase": "...", "items": ["..."]}]})` |
| start / done / drop | `tool.todo({"op": "start", "task": "..."})` (same shape with phase) |
| append | `tool.todo({"op": "append", "phase": "...", "items": ["..."]})` |
| view / rm | `tool.todo({"op": "view"})` |

Any other multi-param tool can be wrapped the same way: `tool.<name>({...})`.

## Secondary damage — the escape hatch that actually matters

When corruption chains, the polluted context makes GLM **sticky-drift into Chinese** for the rest of the
session (measured: ~30% of later responses; re-instructing the language only fixes the next turn). On detection:

1. Switch to eval-wrapped calls immediately (cut off the pollution source)
2. If drift already started, **switch models for the rest of the session** (DeepSeek V4 etc.) or start fresh —
   don't keep going on language re-instructions alone

## Notes

- The eval kernel keeps state per session (variables from one eval call survive to the next)
- `tool.todo()` returns a dict; `result["text"]` has the human-readable todo state
- This is a workaround for the serving-side issue, not a fix. Retire it once the parser is fixed upstream
