import { useState } from "react";
import { claimSession, type SupersededInfo, type SupersededReason } from "./api";
import { formatRelativeTime } from "./format-time";
import "./ClaimGate.css";

export type GateReason = "no-session" | SupersededReason;

interface ClaimGateProps {
  reason: GateReason;
  info: SupersededInfo | null;
  onClaimed: () => void;
}

export default function ClaimGate({ reason, info, onClaimed }: ClaimGateProps) {
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  async function handleClaim() {
    setClaiming(true);
    setError(null);
    try {
      await claimSession();
      onClaimed();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setClaiming(false);
    }
  }

  const superseded = reason === "superseded";

  return (
    <div className="claim-gate">
      <div className="claim-gate-card">
        <h1>Loremaster</h1>
        {superseded ? (
          <>
            <p className="claim-gate-message">
              This session was superseded — another session took over the platform.
            </p>
            <div className="claim-gate-timestamps">
              {info?.stale && (
                <div>Last interaction on your session: {formatRelativeTime(info.stale.lastSeenAt)}</div>
              )}
              {info?.active && (
                <div>Last interaction on the active session: {formatRelativeTime(info.active.lastSeenAt)}</div>
              )}
            </div>
          </>
        ) : (
          <p className="claim-gate-message">This platform hasn't been claimed by this browser yet.</p>
        )}
        {error && <div className="error-banner">{error}</div>}
        <button type="button" onClick={handleClaim} disabled={claiming}>
          {claiming ? "Claiming…" : superseded ? "Take over" : "Claim"}
        </button>
      </div>
    </div>
  );
}
