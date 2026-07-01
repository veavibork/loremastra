import { useEffect, useRef, useState } from "react";
import { fetchLog, postSetupMessage, startKickoff, streamJob, type LogEntry } from "./api";
import LoreView from "./LoreView";
import "./SetupView.css";

export default function SetupView({ storyId, onKickoff }: { storyId: string; onKickoff: () => void }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [pendingReply, setPendingReply] = useState<{ pageId: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [startingKickoff, setStartingKickoff] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetchLog(storyId).then(setEntries);
  }, [storyId]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, pendingReply]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || sending) return;

    const content = draft.trim();
    setDraft("");
    setSending(true);
    setError(null);

    try {
      const { jobId, agentPageId } = await postSetupMessage(storyId, content);
      setEntries(await fetchLog(storyId));
      setPendingReply({ pageId: agentPageId, text: "" });

      streamJob(storyId, jobId, (event) => {
        if (event.type === "token") {
          setPendingReply((prev) => (prev ? { ...prev, text: prev.text + event.text } : prev));
        } else if (event.type === "done") {
          setPendingReply(null);
          void fetchLog(storyId).then(setEntries);
          setSending(false);
        } else if (event.type === "error") {
          setPendingReply(null);
          setError(event.message);
          setSending(false);
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSending(false);
    }
  }

  async function handleKickoff() {
    setStartingKickoff(true);
    setError(null);
    try {
      await startKickoff(storyId);
      onKickoff();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStartingKickoff(false);
    }
  }

  return (
    <div className="setup-view">
      <div className="setup-chat">
        <div className="log">
          {entries
            .filter((entry) => !entry.hidden)
            .map((entry) => (
              <div key={entry.pageId} className={`entry entry-${entry.role}`}>
                <span className="entry-role">{entry.role === "agent" ? "editor" : entry.role}</span>
                <p>{entry.content ?? "…"}</p>
              </div>
            ))}
          {pendingReply && (
            <div className="entry entry-agent entry-pending">
              <span className="entry-role">editor</span>
              <p>{pendingReply.text || "…"}</p>
            </div>
          )}
          <div ref={logEndRef} />
        </div>

        {error && <div className="error-banner">{error}</div>}

        <form className="composer" onSubmit={handleSubmit}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Tell the Editor about your story…"
            disabled={sending}
          />
          <button type="submit" disabled={sending || !draft.trim()}>
            {sending ? "…" : "Send"}
          </button>
        </form>

        <button type="button" className="kickoff-button" onClick={handleKickoff} disabled={startingKickoff}>
          {startingKickoff ? "Starting…" : "Kickoff →"}
        </button>
      </div>

      <div className="setup-worldbook">
        <LoreView storyId={storyId} />
      </div>
    </div>
  );
}
