import { useEffect, useRef, useState } from "react";
import {
  editPost,
  fetchLog,
  fetchPosition,
  postSetupMessage,
  redoPosition,
  retryPost,
  startKickoff,
  streamJob,
  undoPosition,
  type LogEntry,
  type Position,
} from "./api";
import EntryContent from "./EntryContent";
import { RoleLabel } from "./playTabSettings";
import "./StoryView.css";
import "./SetupView.css";

export default function SetupView({ storyId, onKickoff }: { storyId: string; onKickoff: () => void }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [position, setPosition] = useState<Position | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingReply, setPendingReply] = useState<{ pageId: string; text: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [startingKickoff, setStartingKickoff] = useState(false);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [guidingPageId, setGuidingPageId] = useState<string | null>(null);
  const [guidanceDraft, setGuidanceDraft] = useState("");
  const logEndRef = useRef<HTMLDivElement>(null);

  async function refresh() {
    setEntries(await fetchLog(storyId));
    setPosition(await fetchPosition(storyId));
  }

  useEffect(() => {
    void refresh();
  }, [storyId]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, pendingReply]);

  function watchJob(jobId: string, pageId: string) {
    setPendingReply({ pageId, text: "", label: "Thinking..." });
    streamJob(storyId, jobId, (event) => {
      if (event.type === "token") {
        setPendingReply((prev) => (prev ? { ...prev, text: prev.text + event.text } : prev));
      } else if (event.type === "progress") {
        setPendingReply((prev) => (prev ? { ...prev, label: event.label } : prev));
      } else if (event.type === "done") {
        setPendingReply(null);
        void refresh();
        setSending(false);
      } else if (event.type === "error") {
        setPendingReply(null);
        setError(event.message);
        setSending(false);
      }
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || sending) return;

    const content = draft.trim();
    setDraft("");
    setSending(true);
    setError(null);

    try {
      const { jobId, agentPageId } = await postSetupMessage(storyId, content);
      await refresh();
      watchJob(jobId, agentPageId);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setSending(false);
    }
  }

  async function handleRetry(pageId: string, guidance?: string) {
    setSending(true);
    setError(null);
    setGuidingPageId(null);
    try {
      const { jobId } = await retryPost(storyId, pageId, guidance);
      watchJob(jobId, pageId);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setSending(false);
    }
  }

  async function handleSaveEdit(pageId: string) {
    try {
      await editPost(storyId, pageId, editDraft);
      setEditingPageId(null);
      await refresh();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUndo() {
    try {
      setPosition(await undoPosition(storyId));
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRedo() {
    try {
      setPosition(await redoPosition(storyId));
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleKickoff() {
    setStartingKickoff(true);
    setError(null);
    try {
      await startKickoff(storyId);
      onKickoff();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setStartingKickoff(false);
    }
  }

  const visible = entries.filter((e) => !e.hidden && e.pageId !== pendingReply?.pageId);
  const currentIdx = position?.currentPageId ? visible.findIndex((e) => e.pageId === position.currentPageId) : -1;

  return (
    <div className="setup-chat">
      <div className="undo-redo-bar">
          <button type="button" onClick={handleUndo} disabled={sending}>
            ↶ Undo
          </button>
          <button type="button" onClick={handleRedo} disabled={sending || position?.atHead}>
            ↷ Redo
          </button>
        </div>

        <div className="log">
          {visible.map((entry, idx) => {
            const isFuture = currentIdx >= 0 && idx > currentIdx;
            return (
              <div key={entry.pageId} className={`entry entry-${entry.role} ${isFuture ? "entry-future" : ""}`}>
                <RoleLabel role={entry.role} />
                {editingPageId === entry.pageId ? (
                  <div className="edit-box">
                    <textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} />
                    <div className="post-controls">
                      <button type="button" onClick={() => handleSaveEdit(entry.pageId)}>
                        Save
                      </button>
                      <button type="button" onClick={() => setEditingPageId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <EntryContent content={entry.content ?? "…"} />
                    <div className="post-controls">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingPageId(entry.pageId);
                          setEditDraft(entry.content ?? "");
                        }}
                      >
                        Edit
                      </button>
                      {entry.role === "agent" && (
                        <button type="button" onClick={() => handleRetry(entry.pageId)} disabled={sending}>
                          Retry
                        </button>
                      )}
                      {entry.role === "agent" && (
                        <button type="button" onClick={() => setGuidingPageId(entry.pageId)} disabled={sending}>
                          Guided retry
                        </button>
                      )}
                    </div>
                    {guidingPageId === entry.pageId && (
                      <div className="guidance-box">
                        <textarea
                          className="guidance-input"
                          value={guidanceDraft}
                          onChange={(e) => setGuidanceDraft(e.target.value)}
                          placeholder="Direction for the retry…"
                        />
                        <div className="post-controls">
                          <button
                            type="button"
                            onClick={() => {
                              void handleRetry(entry.pageId, guidanceDraft.trim() || undefined);
                              setGuidanceDraft("");
                            }}
                          >
                            Go
                          </button>
                          <button type="button" onClick={() => setGuidingPageId(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {pendingReply && (
            <div className="entry entry-agent entry-pending">
              <RoleLabel role="agent" />
              {pendingReply.text ? <EntryContent content={pendingReply.text} /> : <p>{pendingReply.label}</p>}
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

      <button type="button" className="kickoff-button" onClick={handleKickoff} disabled={startingKickoff || sending}>
        {startingKickoff ? "Starting…" : "Kickoff →"}
      </button>
    </div>
  );
}
