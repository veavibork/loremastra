# Sub-agent routing

Custom agents live in `.claude/agents/`, scoped to specific model/effort tiers so routine asks don't default to a full general-purpose agent:

- `lookup` (haiku, low effort) — answer one narrow factual question by reading/grepping the codebase.
- `researcher` (sonnet, medium effort) — read-only research against external docs/repos/web. No Agent tool, so it can't spawn nested sub-agents.
- `quick-edit` (sonnet, medium effort) — a small, precisely scoped code change to a known location.

Before reaching for `general-purpose` or `claude`, check whether the ask fits one of these narrower agents — match the model/effort to the task instead of defaulting to the biggest option. Use `general-purpose`/`Plan` only for genuinely open-ended, multi-step, or design work that doesn't fit a narrower tier.
