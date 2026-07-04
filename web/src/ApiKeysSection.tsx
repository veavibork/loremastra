import { useEffect, useState } from "react";
import {
  clearFeatherlessKey,
  clearHordeKey,
  fetchAccount,
  setFeatherlessKey,
  setHordeKey,
  type AccountProfile,
} from "./api";
import "./ApiKeysSection.css";

interface KeyRowProps {
  label: string;
  masked: string | null;
  onSave: (key: string) => Promise<void>;
  onClear: () => Promise<void>;
}

function KeyRow({ label, masked, onSave, onClear }: KeyRowProps) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function handleSave() {
    if (!draft.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      await onSave(draft.trim());
      setDraft("");
      setStatus({ kind: "ok", text: "Key saved." });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    setBusy(true);
    setStatus(null);
    try {
      await onClear();
      setStatus({ kind: "ok", text: "Key cleared." });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="api-key-row">
      <label>{label}</label>
      <div className="api-key-current">{masked ? <code>{masked}</code> : <span className="api-key-unset">Not set</span>}</div>
      <div className="api-key-controls">
        <input
          type="password"
          placeholder={`Paste ${label} key…`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
        />
        <button type="button" onClick={() => void handleSave()} disabled={busy || !draft.trim()}>
          Save
        </button>
        <button type="button" onClick={() => void handleClear()} disabled={busy || !masked}>
          Clear
        </button>
      </div>
      {status && <p className={`api-key-status api-key-status-${status.kind}`}>{status.text}</p>}
    </div>
  );
}

/**
 * Per-user Featherless/Horde key management — lives on the Agents tab (not Account Settings)
 * since these keys are what the model configs on this tab actually authenticate against.
 */
export default function ApiKeysSection() {
  const [account, setAccount] = useState<AccountProfile | null>(null);

  useEffect(() => {
    void fetchAccount().then(setAccount);
  }, []);

  if (!account) return null;

  return (
    <section className="api-keys-section">
      <h3>API Keys</h3>
      <p className="api-keys-hint">
        Featherless-backed model configs need a Featherless key here. Jobs using Featherless will fail until one is set.
      </p>
      <KeyRow
        label="Featherless"
        masked={account.featherlessKeyMasked}
        onSave={async (key) => {
          const patch = await setFeatherlessKey(key);
          setAccount((prev) => (prev ? { ...prev, ...patch } : prev));
        }}
        onClear={async () => {
          const patch = await clearFeatherlessKey();
          setAccount((prev) => (prev ? { ...prev, ...patch } : prev));
        }}
      />
      <KeyRow
        label="AI Horde"
        masked={account.hordeKeyMasked}
        onSave={async (key) => {
          const patch = await setHordeKey(key);
          setAccount((prev) => (prev ? { ...prev, ...patch } : prev));
        }}
        onClear={async () => {
          const patch = await clearHordeKey();
          setAccount((prev) => (prev ? { ...prev, ...patch } : prev));
        }}
      />
    </section>
  );
}
