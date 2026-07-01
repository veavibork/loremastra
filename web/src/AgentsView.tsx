import { useEffect, useState } from "react";
import { fetchAgentProfiles, updateAgentProfile, type AgentProfile, type AgentRole } from "./api";
import "./AgentsView.css";

const ROLES: { role: AgentRole; label: string; description: string }[] = [
  { role: "author", label: "Author", description: "Story-phase prose generation." },
  { role: "worker", label: "Worker", description: "Background compression/archiving, no editorializing." },
  { role: "editor", label: "Editor", description: "Setup conversation + archive narrative summaries." },
];

export default function AgentsView() {
  const [profiles, setProfiles] = useState<Record<AgentRole, AgentProfile> | null>(null);
  const [drafts, setDrafts] = useState<Record<AgentRole, AgentProfile> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedRole, setSavedRole] = useState<AgentRole | null>(null);

  useEffect(() => {
    void fetchAgentProfiles().then((p) => {
      setProfiles(p);
      setDrafts(p);
    });
  }, []);

  async function handleSave(role: AgentRole) {
    if (!drafts) return;
    try {
      const saved = await updateAgentProfile(role, drafts[role]);
      setProfiles((prev) => (prev ? { ...prev, [role]: saved } : prev));
      setSavedRole(role);
      setTimeout(() => setSavedRole(null), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function updateDraft(role: AgentRole, patch: Partial<AgentProfile>) {
    setDrafts((prev) => (prev ? { ...prev, [role]: { ...prev[role], ...patch } } : prev));
  }

  if (!drafts) return <div className="agents-view">Loading…</div>;

  return (
    <div className="agents-view">
      <h2>Agents</h2>
      {error && <div className="error-banner">{error}</div>}

      {ROLES.map(({ role, label, description }) => {
        const draft = drafts[role];
        const dirty = profiles && JSON.stringify(profiles[role]) !== JSON.stringify(draft);
        return (
          <div key={role} className="agent-card">
            <div className="agent-card-header">
              <strong>{label}</strong>
              <span className="agent-description">{description}</span>
            </div>
            <label>
              Model
              <input value={draft.model} onChange={(e) => updateDraft(role, { model: e.target.value })} />
            </label>
            <label>
              Fallback models (ranked, comma-separated — tried in order if the model above is unavailable)
              <input
                value={(draft.fallbackModels ?? []).join(", ")}
                onChange={(e) =>
                  updateDraft(role, {
                    fallbackModels: e.target.value
                      .split(",")
                      .map((m) => m.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <div className="agent-numeric-row">
              <label>
                Temperature
                <input
                  type="number"
                  step="0.1"
                  value={draft.temperature}
                  onChange={(e) => updateDraft(role, { temperature: Number(e.target.value) })}
                />
              </label>
              <label>
                Response limit
                <input
                  type="number"
                  value={draft.responseLimit}
                  onChange={(e) => updateDraft(role, { responseLimit: Number(e.target.value) })}
                />
              </label>
              <label>
                Context limit
                <input
                  type="number"
                  value={draft.contextLimit}
                  onChange={(e) => updateDraft(role, { contextLimit: Number(e.target.value) })}
                />
              </label>
            </div>
            <button type="button" onClick={() => handleSave(role)} disabled={!dirty}>
              {savedRole === role ? "Saved" : "Save"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
