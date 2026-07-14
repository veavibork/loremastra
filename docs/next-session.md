### 2. Deferred frontend items

- **Settings editor UX** — Schema-driven forms for global CSS, play tab, banned phrases. Validated JSON textarea for layout config and toggle presets. `json-edit-react` already removed. Layout/toggle preset handling deferred until forms are in place.
- **Context budget visualization** — Token usage breakdown shown to user (gap vs SillyTavern).
- **Per-response metadata** — Model, timing, token count per response (gap vs KoboldAI / SillyTavern).
- **Preference profiles UI** — CRUD API exists at `/api/preference-profiles`; no frontend UI yet.

### 3. Known limitations (non-fixable)

- Featherless server-side request cancellation unsupported — aborting client fetch may not free their concurrency slot until the generation finishes server-side. Tracked in `docs/roadmap.md` play-testing watch list.
