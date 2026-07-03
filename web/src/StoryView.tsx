import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  continuePost,
  editPost,
  fetchActiveJobs,
  fetchLog,
  fetchPosition,
  forkStory,
  kickoff,
  postMessage,
  postSetupMessage,
  redoPosition,
  retryPost,
  startOocSession,
  streamJob,
  undoPosition,
  type LogEntry,
  type Position,
  type StoryPhase,
} from "./api";
import EntryContent from "./EntryContent";
import { RoleLabel } from "./playTabSettings";
import "./StoryView.css";

/** Grows with its content instead of scrolling internally — used for both the composer and
 * inline post editing so neither ever shows a stale, pre-resize box on first paint. Measuring in
 * useLayoutEffect (before the browser paints) rather than useEffect (after) is what avoids a
 * one-frame flash of the wrong size. */
function AutoGrowTextarea({
  value,
  onChange,
  onKeyDown,
  onFocus,
  className,
  placeholder,
  disabled,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const resize = () => {
      // scrollHeight reflects whatever's rendered inside the box, including a wrapped
      // placeholder — for the composer's long instructional placeholder that inflated an
      // empty box to 2-3 lines tall. Hide it for the measurement so height only ever tracks
      // the actual value.
      const placeholder = el.placeholder;
      el.placeholder = "";
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
      el.placeholder = placeholder;
    };
    resize();
    // Catches late metric shifts (e.g. Global CSS's async root-font-size override landing after
    // this first measurement) that the value-keyed effect above has no other reason to rerun for.
    const raf = requestAnimationFrame(resize);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
    />
  );
}

export default function StoryView({
  storyId,
  phase,
  onKickedOff,
}: {
  storyId: string;
  phase: StoryPhase;
  onKickedOff?: () => void;
}) {
  const [mode, setMode] = useState<"guide" | "play">(() => (phase === "setup" ? "guide" : "play"));
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [position, setPosition] = useState<Position | null>(null);
  const [draft, setDraft] = useState("");
  // Keyed by agent pageId so multiple sends can be in flight at once — queued messages each get
  // their own page (and their own streamJob subscription) rather than sharing one slot.
  // startedAt backs the "Thinking… (Ns)" placeholder shown before the first token/progress event
  // arrives — Featherless gives no earlier signal than that, so elapsed wall-clock time is the
  // best available substitute for "..." sitting dead.
  const [pendingReplies, setPendingReplies] = useState<Record<string, { text: string; progress?: string; startedAt: number }>>({});
  const [error, setError] = useState<string | null>(null);
  // Only guards the brief request round-trip for actions that must stay serialized (kickoff,
  // continue, retry) — not held for the whole generation. See the `busy` derivation below for
  // what actually disables those buttons for the full duration.
  const [starting, setStarting] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
  const [forkMode, setForkMode] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  // Tracks whichever edit-mode textarea last had focus, so the toolbar's Delete button knows
  // which draft/selection to act on (touch keyboards sometimes drop their key-entry UI on a
  // text selection, leaving Cut as the only native option — this does a real delete instead).
  const activeEditRef = useRef<{ pageId: string; el: HTMLTextAreaElement } | null>(null);

  async function refresh(): Promise<LogEntry[]> {
    const freshEntries = await fetchLog(storyId);
    setEntries(freshEntries);
    setPosition(await fetchPosition(storyId));
    return freshEntries;
  }

  /**
   * Finds log entries still mid-generation (agent pages with no content yet) and reattaches to
   * whatever job is producing them. Needed because pendingReplies is plain component state —
   * closing the story tab and reopening it remounts StoryView with an empty pendingReplies, and
   * without this the post would just sit rendered as "…" with no live updates until the job
   * finishes and some unrelated action happens to call refresh(). Deliberately only run once on
   * mount/story-switch (below), not from every refresh() — the in-session action handlers
   * (handleSubmit etc.) already call watchJob themselves for jobs they just created, and
   * pendingReplies state wouldn't reflect that yet here (same-render closure), so calling this
   * from a general refresh() would double-subscribe those jobs.
   */
  async function resumeActiveJobs(freshEntries: LogEntry[]) {
    const unresolved = freshEntries.filter((e) => e.role === "agent" && e.content === null && e.textId);
    if (unresolved.length === 0) return;
    try {
      const jobs = await fetchActiveJobs(storyId);
      for (const entry of unresolved) {
        const job = jobs.find((j) => j.targetTextId === entry.textId);
        if (job) watchJob(job.id, entry.pageId, undefined, new Date(job.createdAt).getTime());
      }
    } catch (err) {
      console.error("failed to resume active jobs", err);
    }
  }

  useEffect(() => {
    void (async () => {
      const freshEntries = await refresh();
      await resumeActiveJobs(freshEntries);
    })();
  }, [storyId]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, pendingReplies]);

  // Featherless gives no signal between "request sent" and "first token" — no queue position,
  // no phase label — so the best we can show during that gap is elapsed time. This ticks a
  // render once a second only while something is actually in that dead zone (no text, no
  // progress label yet), rather than running an interval unconditionally.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const waiting = Object.values(pendingReplies).some((p) => !p.text && !p.progress);
    if (!waiting) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [pendingReplies]);

  // True while anything is generating, from any source (a queued send, kickoff, continue, or
  // retry) — gates the actions that need a stable, fully-resolved history to act on unambiguously
  // (Undo/Redo/Retry/Continue/Fork/Kickoff/Edit). The composer is deliberately NOT gated by this —
  // see the form below — so new messages can keep queuing up while earlier ones (including their
  // worldbook checks) are still resolving.
  const busy = starting || Object.keys(pendingReplies).length > 0;

  function watchJob(jobId: string, pageId: string, onDone?: () => void, startedAt?: number) {
    setPendingReplies((prev) => ({ ...prev, [pageId]: { text: "", startedAt: startedAt ?? Date.now() } }));
    streamJob(storyId, jobId, (event) => {
      if (event.type === "token") {
        setPendingReplies((prev) => {
          const cur = prev[pageId];
          return cur ? { ...prev, [pageId]: { ...cur, text: cur.text + event.text } } : prev;
        });
      } else if (event.type === "progress") {
        setPendingReplies((prev) => {
          const cur = prev[pageId];
          return cur ? { ...prev, [pageId]: { ...cur, progress: event.label } } : prev;
        });
      } else if (event.type === "sync") {
        // Replay of whatever the job had already produced before this connection opened —
        // sets rather than appends, since it's a full snapshot, not an incremental token.
        setPendingReplies((prev) => {
          const cur = prev[pageId];
          return cur ? { ...prev, [pageId]: { ...cur, text: event.text, progress: event.progress ?? cur.progress } } : prev;
        });
      } else if (event.type === "done") {
        setPendingReplies((prev) => {
          const { [pageId]: _done, ...rest } = prev;
          return rest;
        });
        void refresh();
        setStarting(false);
        // Pre-kickoff setup turns are dual-pass — a second, separate worldbook-authoring
        // message may have been queued as a direct consequence of this one finishing. Chain a
        // watch onto it so it streams in and gets highlighted live, instead of a generic poll.
        if (event.followUp) watchJob(event.followUp.jobId, event.followUp.pageId);
        onDone?.();
      } else if (event.type === "error") {
        setPendingReplies((prev) => {
          const { [pageId]: _failed, ...rest } = prev;
          return rest;
        });
        setError(event.message);
        setStarting(false);
      }
    });
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!draft.trim() || editMode) return;

    const content = draft.trim();
    setDraft("");
    setError(null);

    try {
      const { jobId, agentPageId } = mode === "guide" ? await postSetupMessage(storyId, content) : await postMessage(storyId, content);
      await refresh();
      watchJob(jobId, agentPageId);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleKickoff() {
    setStarting(true);
    setError(null);
    try {
      const { jobId, agentPageId } = await kickoff(storyId);
      await refresh();
      watchJob(jobId, agentPageId, () => {
        setMode("play");
        onKickedOff?.();
      });
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }

  async function handleContinue(guidance?: string) {
    setStarting(true);
    setError(null);
    try {
      const { jobId, agentPageId } = await continuePost(storyId, guidance);
      await refresh();
      watchJob(jobId, agentPageId);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }

  async function handleRetry(pageId: string, guidance?: string) {
    setStarting(true);
    setError(null);
    try {
      const { jobId } = await retryPost(storyId, pageId, guidance);
      watchJob(jobId, pageId);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }

  function handleContinueClick() {
    const guidance = draft.trim() || undefined;
    setDraft("");
    void handleContinue(guidance);
  }

  function handleRetryClick(pageId: string) {
    const guidance = draft.trim() || undefined;
    setDraft("");
    void handleRetry(pageId, guidance);
  }

  async function toggleEditMode() {
    if (!editMode) {
      const seeded: Record<string, string> = {};
      for (const entry of shown) seeded[entry.pageId] = entry.content ?? "";
      setEditDrafts(seeded);
      setEditMode(true);
      return;
    }

    const changed = shown.filter((entry) => {
      const value = editDrafts[entry.pageId];
      return value !== undefined && value !== (entry.content ?? "");
    });
    setEditMode(false);
    if (changed.length > 0) {
      try {
        await Promise.all(changed.map((entry) => editPost(storyId, entry.pageId, editDrafts[entry.pageId])));
        await refresh();
      } catch (err) {
        console.error(err);
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    setEditDrafts({});
    activeEditRef.current = null;
  }

  /** Performs an actual forward-delete on whichever edit box was last focused, bypassing
   * whatever native key-entry UI the platform did or didn't show for the current selection.
   * Routed through execCommand (deprecated but still broadly supported, including Android Chrome)
   * rather than a direct value splice, since only edits made that way register in the browser's
   * own undo stack — a plain state update wouldn't be Ctrl+Z-able the way a real keypress is. */
  function handleDeleteKey() {
    const active = activeEditRef.current;
    if (!active) return;
    const { pageId, el } = active;
    el.focus();
    const hasSelection = el.selectionStart !== el.selectionEnd;
    const handled = document.execCommand(hasSelection ? "delete" : "forwardDelete");
    if (handled) {
      setEditDrafts((prev) => ({ ...prev, [pageId]: el.value }));
      return;
    }
    // Fallback for environments without execCommand support — same net result, just not undoable.
    const value = editDrafts[pageId] ?? "";
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = start === end ? value.slice(0, start) + value.slice(start + 1) : value.slice(0, start) + value.slice(end);
    setEditDrafts((prev) => ({ ...prev, [pageId]: next }));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start, start);
    });
  }

  async function handleUndo() {
    try {
      setPosition(await undoPosition(storyId));
      await refresh();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRedo() {
    try {
      setPosition(await redoPosition(storyId));
      await refresh();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Every Play→OOC switch post-kickoff needs a real backend call now — it drops a canned
   * EDITOR_UPDATE_OPENING opener and marks a fresh session boundary so the Editor's context
   * resets instead of replaying every OOC turn the story has ever had. Pre-kickoff setup is
   * already in guide mode by default (from the initial useState above), so this only fires
   * once the story has actually reached story phase.
   */
  async function handleEnterOoc() {
    if (phase !== "setup") {
      try {
        await startOocSession(storyId);
        await refresh();
      } catch (err) {
        console.error(err);
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    setMode("guide");
  }

  async function handleFork(pageId: string) {
    setForkMode(false);
    try {
      const forked = await forkStory(storyId, pageId);
      setError(null);
      alert(`Forked as "${forked.name}". Switch stories to play it (Saves UI isn't built yet).`);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const pendingIds = new Set(Object.keys(pendingReplies));
  // Every OOC/setup page is hidden the moment it's created, whether that's the original
  // pre-kickoff conversation or a later resumed one — and no IC page ever is (see
  // POST /:id/setup/messages). So Play/IC and Guide/OOC are exact mirror-opposite filters on the
  // same flag: this is what keeps a resumed OOC chat from also showing the interleaved IC story
  // it now shares a page chain with, and vice versa.
  const visible = entries.filter((e) => (mode === "play" ? !e.hidden : e.hidden) && !pendingIds.has(e.pageId));
  const currentIdx = position?.currentPageId ? visible.findIndex((e) => e.pageId === position.currentPageId) : -1;
  // Rewound past this point? Don't render what comes after — Redo is the only way forward.
  const shown = currentIdx >= 0 ? visible.slice(0, currentIdx + 1) : visible;
  const lastEntry = shown[shown.length - 1];
  const canRetry = !!lastEntry && lastEntry.role === "agent";
  // Queued sends whose agent page already exists (created synchronously) but hasn't resolved yet —
  // rendered after `shown` in the same relative order they were created, live-updated by whichever
  // are actually streaming right now via pendingReplies.
  const pendingEntries = entries.filter((e) => pendingIds.has(e.pageId) && (mode === "play" ? !e.hidden : e.hidden));

  return (
    <div className="story-view">
      <div className="log">
        {shown.map((entry) => (
          <div key={entry.pageId} className={`entry entry-${entry.role}`}>
            <RoleLabel role={entry.role} mode={mode} />
            {editMode ? (
              <AutoGrowTextarea
                className="edit-box-textarea"
                value={editDrafts[entry.pageId] ?? entry.content ?? ""}
                onChange={(value) => setEditDrafts((prev) => ({ ...prev, [entry.pageId]: value }))}
                onFocus={(e) => { activeEditRef.current = { pageId: entry.pageId, el: e.currentTarget }; }}
              />
            ) : (
              <>
                <EntryContent content={entry.content ?? "…"} highlightBlocks={mode === "guide"} />
                {forkMode && (
                  <button type="button" className="fork-point-btn" onClick={() => void handleFork(entry.pageId)}>
                    ⑂ fork from here
                  </button>
                )}
              </>
            )}
          </div>
        ))}
        {pendingEntries.map((entry) => {
          const pending = pendingReplies[entry.pageId];
          const elapsed = pending ? Math.max(0, Math.round((Date.now() - pending.startedAt) / 1000)) : 0;
          return (
            <div key={entry.pageId} className="entry entry-agent entry-pending">
              <RoleLabel role="agent" mode={mode} />
              {pending?.text ? (
                <EntryContent content={pending.text} highlightBlocks={mode === "guide"} />
              ) : (
                <p className="pending-thinking">{pending?.progress ?? `Thinking… (${elapsed}s)`}</p>
              )}
            </div>
          );
        })}
        <div ref={logEndRef} />
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="play-toolbar">
        <div className="mode-toggle">
          <button type="button" className={mode === "guide" ? "active" : ""} onClick={() => void handleEnterOoc()} disabled={busy || editMode}>
            OOC
          </button>
          <button type="button" className={mode === "play" ? "active" : ""} onClick={() => setMode("play")} disabled={busy || editMode}>
            IC
          </button>
        </div>
        <button type="button" onClick={handleUndo} disabled={busy || editMode || !position?.canUndo}>
          ↶ Undo
        </button>
        <button type="button" onClick={handleRedo} disabled={busy || editMode || !position?.canRedo}>
          ↷ Redo
        </button>
        <button
          type="button"
          onClick={() => lastEntry && handleRetryClick(lastEntry.pageId)}
          disabled={busy || editMode || !canRetry}
        >
          Retry
        </button>
        <button type="button" onClick={handleContinueClick} disabled={busy || editMode}>
          Continue
        </button>
        <button type="button" onClick={() => void toggleEditMode()} disabled={busy}>
          {editMode ? "Done editing" : "Edit"}
        </button>
        {editMode && (
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={handleDeleteKey}>
            Delete
          </button>
        )}
        <button
          type="button"
          className={forkMode ? "active" : ""}
          onClick={() => setForkMode((f) => !f)}
          disabled={busy || editMode}
        >
          Fork
        </button>
        {mode === "guide" && phase === "setup" && (
          <button type="button" onClick={() => void handleKickoff()} disabled={busy || editMode}>
            Kickoff →
          </button>
        )}
        {position && !position.atHead && (
          <span className="rewind-note">Viewing an earlier point — new posts will branch from here.</span>
        )}
      </div>

      <form className="composer" onSubmit={handleSubmit}>
        <AutoGrowTextarea
          value={draft}
          onChange={setDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (editMode) return;
              if (draft.trim()) {
                void handleSubmit();
              } else if (!busy) {
                // Continue (unlike Send) isn't queueable — it acts on "whatever's current" once
                // an existing reply resolves, so it stays serialized behind anything pending.
                handleContinueClick();
              }
            }
          }}
          placeholder={
            mode === "guide"
              ? "Tell the Editor about your story… (Enter on an empty box continues; also used as guidance for Retry/Continue)"
              : "Say something… (Enter on an empty box continues; also used as guidance for Retry/Continue)"
          }
          disabled={editMode}
        />
        <button type="submit" disabled={editMode || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
