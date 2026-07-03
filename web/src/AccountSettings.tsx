import { useEffect, useState } from "react";
import { changePassword, fetchAccount, updateDisplayName } from "./api";
import "./AccountSettings.css";

export default function AccountSettings() {
  const [displayName, setDisplayName] = useState("");
  const [savedDisplayName, setSavedDisplayName] = useState<string | null>(null);
  const [nameStatus, setNameStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [savingName, setSavingName] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordStatus, setPasswordStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    void fetchAccount().then((account) => {
      setDisplayName(account.displayName);
      setSavedDisplayName(account.displayName);
    });
  }, []);

  async function handleSaveName() {
    const trimmed = displayName.trim();
    if (!trimmed || trimmed === savedDisplayName) return;
    setSavingName(true);
    setNameStatus(null);
    try {
      const account = await updateDisplayName(trimmed);
      setDisplayName(account.displayName);
      setSavedDisplayName(account.displayName);
      setNameStatus({ kind: "ok", text: "Display name updated." });
    } catch (err) {
      setNameStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSavingName(false);
    }
  }

  async function handleSavePassword() {
    setPasswordStatus(null);
    if (newPassword.length < 8) {
      setPasswordStatus({ kind: "error", text: "New password must be at least 8 characters." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordStatus({ kind: "error", text: "New password and confirmation don't match." });
      return;
    }
    setSavingPassword(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordStatus({ kind: "ok", text: "Password updated." });
    } catch (err) {
      setPasswordStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <section className="account-settings">
      <h3>Account</h3>

      <div className="account-settings-field">
        <label htmlFor="account-display-name">Display name</label>
        <div className="account-settings-row">
          <input
            id="account-display-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <button
            type="button"
            onClick={() => void handleSaveName()}
            disabled={savingName || !displayName.trim() || displayName.trim() === savedDisplayName}
          >
            Save
          </button>
        </div>
        {nameStatus && <p className={`account-settings-status account-settings-status-${nameStatus.kind}`}>{nameStatus.text}</p>}
      </div>

      <div className="account-settings-field">
        <label>Change password</label>
        <div className="account-settings-password-fields">
          <input
            type="password"
            placeholder="Current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
          />
          <input
            type="password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <button
          type="button"
          onClick={() => void handleSavePassword()}
          disabled={savingPassword || !currentPassword || !newPassword || !confirmPassword}
        >
          Update password
        </button>
        {passwordStatus && (
          <p className={`account-settings-status account-settings-status-${passwordStatus.kind}`}>{passwordStatus.text}</p>
        )}
      </div>
    </section>
  );
}
