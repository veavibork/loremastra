import { useEffect, useRef, useState } from "react";
import { approveKickoff, backToSetup, fetchLog, retryKickoff, streamJob, type LogEntry } from "./api";
import "./SetupView.css";

export default function KickoffView({
  storyId,
  onApproved,
  onBack,
}: {
  storyId: string;
  onApproved: () => void;
  onBack: () => void;
}) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [pendingReply, setPendingReply] = useState<string | null>(null);
  const [guidance, setGuidance] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetchLog(storyId).then(setEntries);
  }, [storyId]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, pendingReply]);

  function watchJob(jobId: string) {
    setPendingReply("");
    streamJob(storyId, jobId, (event) => {
      if (event.type === "token") {
        setPendingReply((prev) => (prev ?? "") + event.text);
      } else if (event.type === "done") {
        setPendingReply(null);
        void fetchLog(storyId).then(setEntries);
        setBusy(false);
      } else if (event.type === "error") {
        setPendingReply(null);
        setError(event.message);
        setBusy(false);
      }
    });
  }

  async function handleRegenerate() {
    setBusy(true);
    setError(null);
    try {
      const { jobId } = await retryKickoff(storyId, guidance.trim() || undefined);
      setGuidance("");
      watchJob(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function handleApprove() {
    setBusy(true);
    setError(null);
    try {
      await approveKickoff(storyId);
      onApproved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function handleBack() {
    setBusy(true);
    setError(null);
    try {
      await backToSetup(storyId);
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const visible = entries.filter((e) => !e.hidden);
  const openingPost = visible[visible.length - 1];
  const setupHistory = visible.slice(0, -1);

  return (
    <div className="setup-view">
      <div className="setup-chat">
        <div className="log">
          {setupHistory.map((entry) => (
            <div key={entry.pageId} className={`entry entry-${entry.role}`}>
              <span className="entry-role">{entry.role === "agent" ? "editor" : entry.role}</span>
              <p>{entry.content ?? "…"}</p>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
        <button type="button" onClick={handleBack} disabled={busy}>
          ← Back to Setup
        </button>
      </div>

      <div className="setup-worldbook kickoff-preview">
        <h2>Opening Post</h2>
        <div className="opening-post">
          <p>{pendingReply !== null ? pendingReply || "…" : (openingPost?.content ?? "…")}</p>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <textarea
          className="guidance-input"
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          placeholder="Optional direction for a regenerate (e.g. make it shorter, start in the rain)…"
          disabled={busy}
        />
        <div className="kickoff-actions">
          <button type="button" onClick={handleRegenerate} disabled={busy}>
            {busy ? "…" : "Regenerate"}
          </button>
          <button type="button" onClick={handleApprove} disabled={busy}>
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
