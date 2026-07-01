import { useEffect, useState } from "react";
import { fetchLayout, updateLayout } from "./api";
import "./SettingsView.css";

export default function SettingsView() {
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void fetchLayout().then((res) => setRaw(JSON.stringify(res.config, null, 2)));
  }, []);

  async function handleSave() {
    setError(null);
    setSaved(false);
    try {
      const parsed = JSON.parse(raw);
      await updateLayout(parsed);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="settings-view">
      <h2>Settings</h2>

      <section>
        <h3>Layout</h3>
        <p className="settings-note">
          Phase 1's layout system is config-driven but read-only — no drag-and-drop editor yet.
          Rearranging sections/tabs is a direct JSON edit, per loremaster.md's UI Structure section.
        </p>
        {error && <div className="error-banner">{error}</div>}
        <textarea className="layout-json" value={raw} onChange={(e) => setRaw(e.target.value)} spellCheck={false} />
        <button type="button" onClick={handleSave}>
          {saved ? "Saved" : "Save layout"}
        </button>
      </section>
    </div>
  );
}
