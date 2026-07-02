import { useEffect, useRef, useState } from "react";
import {
  continuePost,
  editPost,
  fetchLog,
  fetchPosition,
  forkStory,
  jumpToPosition,
  postMessage,
  redoPosition,
  retryPost,
  streamJob,
  undoPosition,
  type LogEntry,
  type Position,
} from "./api";
import EntryContent from "./EntryContent";
import "./StoryView.css";

export default function StoryView({ storyId }: { storyId: string }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [position, setPosition] = useState<Position | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingReply, setPendingReply] = useState<{ pageId: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [guidingPageId, setGuidingPageId] = useState<string | "continue" | null>(null);
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
    setPendingReply({ pageId, text: "" });
    streamJob(storyId, jobId, (event) => {
      if (event.type === "token") {
        setPendingReply((prev) => (prev ? { ...prev, text: prev.text + event.text } : prev));
      } else if (event.type === "done") {
        setPendingReply(null);
        void refresh();
        setBusy(false);
      } else if (event.type === "error") {
        setPendingReply(null);
        setError(event.message);
        setBusy(false);
      }
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || busy) return;

    const content = draft.trim();
    setDraft("");
    setBusy(true);
    setError(null);

    try {
      const { jobId, agentPageId } = await postMessage(storyId, content);
      await refresh();
      watchJob(jobId, agentPageId);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function handleContinue(guidance?: string) {
    setBusy(true);
    setError(null);
    setGuidingPageId(null);
    try {
      const { jobId, agentPageId } = await continuePost(storyId, guidance);
      await refresh();
      watchJob(jobId, agentPageId);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function handleRetry(pageId: string, guidance?: string) {
    setBusy(true);
    setError(null);
    setGuidingPageId(null);
    try {
      const { jobId } = await retryPost(storyId, pageId, guidance);
      watchJob(jobId, pageId);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
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

  async function handleJump(pageId: string) {
    try {
      setPosition(await jumpToPosition(storyId, pageId));
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleFork(pageId: string) {
    try {
      const forked = await forkStory(storyId, pageId);
      setError(null);
      alert(`Forked as "${forked.name}". Switch stories to play it (Saves UI isn't built yet).`);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const visible = entries.filter((e) => !e.hidden && e.pageId !== pendingReply?.pageId);
  const currentIdx = position?.currentPageId ? visible.findIndex((e) => e.pageId === position.currentPageId) : -1;

  return (
    <>
      <div className="undo-redo-bar">
        <button type="button" onClick={handleUndo} disabled={busy}>
          ↶ Undo
        </button>
        <button type="button" onClick={handleRedo} disabled={busy || position?.atHead}>
          ↷ Redo
        </button>
        {position && !position.atHead && <span className="rewind-note">Viewing an earlier point — new posts will branch from here.</span>}
      </div>

      <div className="log">
        {visible.map((entry, idx) => {
          const isFuture = currentIdx >= 0 && idx > currentIdx;
          return (
            <div key={entry.pageId} className={`entry entry-${entry.role} ${isFuture ? "entry-future" : ""}`}>
              <span className="entry-role">{entry.role}</span>
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
                      <button type="button" onClick={() => handleRetry(entry.pageId)} disabled={busy}>
                        Retry
                      </button>
                    )}
                    {entry.role === "agent" && (
                      <button type="button" onClick={() => setGuidingPageId(entry.pageId)} disabled={busy}>
                        Guided retry
                      </button>
                    )}
                    {isFuture && (
                      <button type="button" onClick={() => handleJump(entry.pageId)}>
                        Jump here
                      </button>
                    )}
                    <button type="button" onClick={() => handleFork(entry.pageId)}>
                      Fork from here
                    </button>
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
            <span className="entry-role">agent</span>
            {pendingReply.text ? <EntryContent content={pendingReply.text} /> : <p>…</p>}
          </div>
        )}
        <div ref={logEndRef} />
      </div>

      {error && <div className="error-banner">{error}</div>}

      {guidingPageId === "continue" ? (
        <div className="guidance-box">
          <textarea
            className="guidance-input"
            value={guidanceDraft}
            onChange={(e) => setGuidanceDraft(e.target.value)}
            placeholder="Direction for the continuation…"
          />
          <div className="post-controls">
            <button
              type="button"
              onClick={() => {
                void handleContinue(guidanceDraft.trim() || undefined);
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
      ) : (
        <form className="composer" onSubmit={handleSubmit}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Say something…"
            disabled={busy}
          />
          <button type="submit" disabled={busy || !draft.trim()}>
            {busy ? "…" : "Send"}
          </button>
          <button type="button" onClick={() => handleContinue()} disabled={busy}>
            Continue
          </button>
          <button type="button" onClick={() => setGuidingPageId("continue")} disabled={busy}>
            Guided continue
          </button>
        </form>
      )}
    </>
  );
}
