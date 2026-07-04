# Loremaster roadmap

High-level backlog only — named items still open, one line each. For milestone history, status, and
implementation detail see [development.md](development.md). For stubs, known gaps, and play-test
questions see [stub-revisions.md](stub-revisions.md).

**Build backlog** below = work to pick up when ready. **Play-testing watch list** = observe during
real sessions; act only if the named problem actually shows up.

---

## Phase 1 gaps

- **Input bar weapon wheel UI** — toggles wired via Settings presets + JSON containers; radial wheel UI still deferred ([development.md](development.md), [loremaster.md](../loremaster.md))
- **Config > Prompts override editor** — per-user/per-story Author system prompt overrides; core prompt exists but isn't editable in UI ([stub-revisions.md](stub-revisions.md))
- **Settings preference profiles** — named snapshots of full settings state; table exists, no CRUD UI ([stub-revisions.md](stub-revisions.md))
- **Bespoke touch-first chrome** — status-icon nav, half-transparent sidebar, touch-first interaction pattern deferred in favor of plain controls ([development.md](development.md))
- **Cross-story Debug view** — Debug panel scoped to active story only ([stub-revisions.md](stub-revisions.md))
- **Client error friendly titles** — human-readable explanations for raw fetch/CORS failures; revisit after real usage data ([development.md](development.md))
- **Summary tab cleanup** — legacy `gen_extract` view; compression retired; remove or repurpose ([development.md](development.md))

## Security & data

- **Encryption at rest (story content + metadata)** — password-derived keys for full user data blobs; API keys already encrypted per-user ([development.md](development.md), [loremaster.md](../loremaster.md))
- **Per-user file-level data isolation** — split `global.sqlite` user-scoped tables into one SQLite file per user for unit encryption ([development.md](development.md))

## Memory & lore

- **MemoryView stale copy** — UI still references old Setting/Register/PC labels; cosmetic until Lore polish pass ([development.md](development.md), [stub-revisions.md](stub-revisions.md))
- **Worldbook deltas** — story-state changes stored separately from canonical entries so events don't contaminate baseline lore ([loremaster.md](../loremaster.md) Future Phases, [stub-revisions.md](stub-revisions.md))
- **Fork point-in-time worldbook** — forks copy latest worldbook state, not reconstructed as-of fork timestamp ([development.md](development.md), [stub-revisions.md](stub-revisions.md))

## UI / UX polish

- **WYSIWYG layout editing** — drag-and-drop editor for per-user layout config; device-aware binding and resize handling ([loremaster.md](../loremaster.md) Future Phases)
- **Iconographic / app-style interface** — richer visual layer on top of current functional chrome ([loremaster.md](../loremaster.md) Future Phases)

## Infra & providers

- **Per-fallback model params** — `withModelFallback` swaps model id only; fallback rows' temperature/sampler settings ignored at runtime ([stub-revisions.md](stub-revisions.md))
- **HF tag sync refresh policy** — local `hf-model-tags.json` + sync script exist; run periodically and expand model coverage ([featherless-notes.md](featherless-notes.md))
- **Additional inference providers** — generic OpenAI-compatible endpoints (LM Studio, AnythingLLM, etc.) ([loremaster.md](../loremaster.md) Future Phases)
- **Provider content-permissiveness flags** — surface PG-only vs ERP-capable as visible user choice ([loremaster.md](../loremaster.md), [featherless-tag-taxonomy.md](featherless-tag-taxonomy.md))
- **Creative tag AND/OR semantics** — how to combine multiple `creative=` tag filters for model discovery not yet tested ([featherless-tag-taxonomy.md](featherless-tag-taxonomy.md))

## Future phases

- **Creature entry emphasis mode** — tooling to decide when a creature ROSTER entry is warranted vs baseline model knowledge ([loremaster.md](../loremaster.md))
- **Outside MCP client support** — LM consuming third-party MCP servers; no concrete use case yet ([loremaster.md](../loremaster.md))

---

## Play-testing watch list

Observe during real VM sessions; no build until a problem is confirmed.

- **Tag-gen after setup** — background worker auto-tags from worldbook extraction; may overlap user-curated tags → disable tag-gen if conflicts show up ([development.md](development.md), [stub-revisions.md](stub-revisions.md))
- **Bracket tag formatting** — malformed or unclosed `[CONTENT]`/`[ROSTER]`/`[MEMORY]` pairs silently produce zero entries → revisit validation only if this is common ([stub-revisions.md](stub-revisions.md))
- **Editor vs worldbook mismatch** — model may claim lore is saved without emitting bracket blocks → catch via Lore UI preview and manual fix ([development.md](development.md))
- **PC address mode** — Author uses 2nd-person default; don't switch 2nd/3rd/1st until real sessions show a need ([stub-revisions.md](stub-revisions.md))
- **Guided retry directions** — plain-text guidance (e.g. "make it shorter") may be ignored; model behavior, not a code bug ([development.md](development.md))
- **Fork from far back** — worldbook stays at latest state, not fork-point snapshot; watch if deep forks feel wrong ([development.md](development.md), [stub-revisions.md](stub-revisions.md))
- **Story-to-date quality at scale** — watch word count, seam quality, and regen behavior after edits on long stories ([story-to-date-experiment.md](story-to-date-experiment.md))
- **Cancel vs Featherless slot** — client Stop may not free server-side concurrency; watch `used_cost` on `/account/concurrency/stream` around a cancel ([stub-revisions.md](stub-revisions.md), [featherless-notes.md](featherless-notes.md))
- **Per-fallback sampler params** — only the primary row's temperature/sampler settings apply across the fallback chain → rebuild if wrong-model behavior shows up ([stub-revisions.md](stub-revisions.md))
- **Featherless `creative=` tags** — `creative=roleplay` / `creative=erp` are soft, unverified signals for model discovery ([featherless-tag-taxonomy.md](featherless-tag-taxonomy.md))
