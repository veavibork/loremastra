import { useEffect, useState } from "react";
import {
  createBannedPhrase,
  deleteBannedPhrase,
  fetchBannedPhrases,
  fetchLayout,
  updateLayout,
  type BannedPhrase,
} from "./api";
import "./SettingsView.css";

export default function SettingsView() {
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [bannedPhrases, setBannedPhrases] = useState<BannedPhrase[]>([]);
  const [newPhrase, setNewPhrase] = useState("");
  const [bannedError, setBannedError] = useState<string | null>(null);

  useEffect(() => {
    void fetchLayout().then((res) => setRaw(JSON.stringify(res.config, null, 2)));
    void reloadBannedPhrases();
  }, []);

  async function reloadBannedPhrases() {
    setBannedPhrases(await fetchBannedPhrases());
  }

  async function handleSave() {
    setError(null);
    setSaved(false);
    try {
      const parsed = JSON.parse(raw);
      await updateLayout(parsed);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAddBannedPhrase(e: React.FormEvent) {
    e.preventDefault();
    if (!newPhrase.trim()) return;
    setBannedError(null);
    try {
      await createBannedPhrase(newPhrase.trim());
      setNewPhrase("");
      await reloadBannedPhrases();
    } catch (err) {
      console.error(err);
      setBannedError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRemoveBannedPhrase(id: string) {
    try {
      await deleteBannedPhrase(id);
      await reloadBannedPhrases();
    } catch (err) {
      console.error(err);
      setBannedError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="settings-view">
      <h2>Settings</h2>

      <section>
        <h3>Banned words/phrases</h3>
        <p className="settings-note">
          Passed as the "stop" parameter on every Author/Worker/Editor call — generation halts the
          instant one of these would be produced. Featherless's real tokenize endpoint doesn't expose
          token ids (confirmed live, contradicts its own docs), so this is string-based only; there's no
          stop_token_ids equivalent to layer on top.
        </p>
        {bannedError && <div className="error-banner">{bannedError}</div>}
        <form className="banned-phrase-form" onSubmit={handleAddBannedPhrase}>
          <input value={newPhrase} onChange={(e) => setNewPhrase(e.target.value)} placeholder="phrase to ban" />
          <button type="submit">Add</button>
        </form>
        <div className="banned-phrase-row">
          {bannedPhrases.length === 0 && <span className="settings-note">None banned yet.</span>}
          {bannedPhrases.map((p) => (
            <span key={p.id} className="banned-phrase-bubble">
              {p.phrase}
              <button type="button" onClick={() => handleRemoveBannedPhrase(p.id)} aria-label={`Remove ${p.phrase}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      </section>

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
