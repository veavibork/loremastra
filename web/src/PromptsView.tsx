export default function PromptsView() {
  return (
    <div className="prompts-view">
      <h2>Prompts</h2>
      <p>
        Per-user prompt template overrides aren't built yet. The Author has no "core prompt" at all
        currently (an explicit deferred decision — see docs/roadmap.md), so there's nothing to expose an
        editor for yet. The Worker's compression prompt, the Editor's archive-summary prompt, and the
        Editor's setup-conversation prompt are all still fixed in code.
      </p>
    </div>
  );
}
