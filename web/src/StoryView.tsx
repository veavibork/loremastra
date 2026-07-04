import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  cancelJob,
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
import { toast } from "./toast";
import ButtonContainerRow from "./ButtonContainerRow";
import { DEFAULT_INPUT_BAR } from "./layoutUtils";
import { useStoryToggles } from "./storyToggles";
import type { LayoutRegion } from "./api";
import "./StoryView.css";

/** Grows with its content instead of scrolling internally — used for both the composer and
 * tap-to-edit's single edit box so neither ever shows a stale, pre-resize box on first paint.
 * Measuring in useLayoutEffect (before the browser paints) rather than useEffect (after) is what
 * avoids a one-frame flash of the wrong size.
 *
 * `initialHeight`, when given, is applied via the ref callback (fires during commit, before any
 * effect) rather than the default browser intrinsic (one row) — StoryView seeds this from the
 * tapped post's own rendered height at the moment it's tapped into edit mode, so the box doesn't
 * visibly shrink to one line and then regrow once its own layout effect corrects it. */
function AutoGrowTextarea({
  value,
  onChange,
  onKeyDown,
  onFocus,
  className,
  placeholder,
  disabled,
  autoFocus,
  initialHeight,
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  initialHeight?: number;
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
      ref={(el) => {
        ref.current = el;
        // Guards against re-applying on every render (callback refs re-fire then) — once the
        // layout effect above has set a real height, style.height is no longer empty and this
        // becomes a no-op.
        if (el && initialHeight && !el.style.height) el.style.height = `${initialHeight}px`;
      }}
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

/** Nav's tab-based layout unmounts a panel entirely when its column is closed, so plain
 * useState loses which mode (IC/OOC) a story was in the moment the Story tab is reopened —
 * it'd always fall back to the phase-based default below. Restoring from here on mount (and
 * writing to it on every change) means reopening the tab lands back exactly where it was left,
 * with no extra startOocSession call — see handleEnterOoc, which only fires from an explicit
 * toggle click, never from this restore path. */
function modeStorageKey(storyId: string): string {
  return `loremaster.storyMode.${storyId}`;
}

function loadPersistedMode(storyId: string): "guide" | "play" | null {
  const raw = localStorage.getItem(modeStorageKey(storyId));
  return raw === "guide" || raw === "play" ? raw : null;
}

/**
 * Maps a click's page coordinates to an offset in the *source* content string (not the rendered
 * text — bold/italic markers are stripped on render, see EntryContent's renderInline), so
 * tap-to-edit can drop the cursor where the user actually clicked instead of always at the start.
 * Walks up from whatever DOM node the browser's caret-hit-testing API resolved to until it finds
 * one of EntryContent's data-src-start-tagged spans/strong/em elements, then adds the in-node
 * offset to that span's recorded source-string start. Returns null if the browser lacks both
 * caret-hit-testing APIs (very old browsers) or the click didn't land in a tagged span at all —
 * callers should fall back to "end of content" in that case.
 */
function resolveClickOffset(clientX: number, clientY: number, contentEl: HTMLElement): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (typeof document.caretRangeFromPoint === "function") {
    const range = document.caretRangeFromPoint(clientX, clientY);
    if (!range) return null;
    node = range.startContainer;
    offset = range.startOffset;
  } else if (typeof doc.caretPositionFromPoint === "function") {
    const pos = doc.caretPositionFromPoint(clientX, clientY);
    if (!pos) return null;
    node = pos.offsetNode;
    offset = pos.offset;
  } else {
    return null;
  }
  if (!node || !contentEl.contains(node)) return null;

  // Hit-testing usually lands inside a text node (offset = character index within it), but
  // browsers sometimes resolve to an element boundary instead — e.g. clicking below the last
  // line, in the box's padding. There, `offset` is a *child-node index*, not a character count;
  // treating it as one is what caused the cursor to consistently land near the start of whichever
  // span was childNodes[0]. Normalize down to the nearest real text node (its very start or very
  // end, depending on which side of the boundary the click landed) before walking up for a
  // data-src-start-tagged ancestor.
  if (node.nodeType !== Node.TEXT_NODE) {
    const children = node.childNodes;
    if (children.length === 0) return null;
    const landedAfterLastChild = offset >= children.length;
    let child: Node = children[Math.min(offset, children.length - 1)];
    while (child.nodeType !== Node.TEXT_NODE && child.childNodes.length > 0) {
      child = landedAfterLastChild ? child.childNodes[child.childNodes.length - 1] : child.childNodes[0];
    }
    if (child.nodeType !== Node.TEXT_NODE) return null;
    node = child;
    offset = landedAfterLastChild ? (child.textContent?.length ?? 0) : 0;
  }

  let el: HTMLElement | null = node.parentElement;
  while (el && el !== contentEl && el.dataset.srcStart === undefined) {
    el = el.parentElement;
  }
  if (!el || el.dataset.srcStart === undefined) return null;
  return parseInt(el.dataset.srcStart, 10) + offset;
}

export default function StoryView({
  storyId,
  phase,
  onKickedOff,
  inputBar,
}: {
  storyId: string;
  phase: StoryPhase;
  onKickedOff?: () => void;
  inputBar?: LayoutRegion;
}) {
  const toggles = useStoryToggles(storyId);
  const toolbarContainers = inputBar?.containers?.length ? inputBar.containers : DEFAULT_INPUT_BAR.containers;
  const [mode, setMode] = useState<"guide" | "play">(
    () => loadPersistedMode(storyId) ?? (phase === "setup" ? "guide" : "play")
  );

  useEffect(() => {
    localStorage.setItem(modeStorageKey(storyId), mode);
  }, [storyId, mode]);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [position, setPosition] = useState<Position | null>(null);
  const [draft, setDraft] = useState("");
  // Keyed by agent pageId so multiple sends can be in flight at once — queued messages each get
  // their own page (and their own streamJob subscription) rather than sharing one slot.
  // startedAt backs the "Thinking… (Ns)" placeholder shown before the first token/progress event
  // arrives — Featherless gives no earlier signal than that, so elapsed wall-clock time is the
  // best available substitute for "..." sitting dead.
  const [pendingReplies, setPendingReplies] = useState<Record<string, { text: string; progress?: string; startedAt: number; jobId: string }>>({});
  // Horde (and compress/archive) jobs can't be aborted mid-generation — the cancel route 409s
  // rather than actually stopping anything. Rather than a stop button that just fails silently,
  // pageIds in here are hidden from the log entirely while the job keeps running in the
  // background; they come back on their own once the job resolves (see watchJob's cleanup).
  const [hiddenPending, setHiddenPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Only guards the brief request round-trip for actions that must stay serialized (kickoff,
  // continue, retry) — not held for the whole generation. See the `busy` derivation below for
  // what actually disables those buttons for the full duration.
  const [starting, setStarting] = useState(false);
  // Tap-to-edit: at most one post editable at a time (see handleLogClick). null means nothing is
  // being edited and every post renders as plain read-only content.
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editInitialHeight, setEditInitialHeight] = useState<number | undefined>(undefined);
  // Set on focus so the overlay's Delete (forward-delete) button acts on the one box that can
  // possibly be focused — see handleDeleteKey's doc comment for why this uses execCommand.
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Where to drop the cursor once the edit textarea mounts and focuses (see handleLogClick and
  // its onFocus consumer below) — a ref rather than state since it's a one-shot instruction, not
  // something that should trigger its own re-render.
  const pendingCaretRef = useRef<number | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

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
    setPendingReplies((prev) => ({ ...prev, [pageId]: { text: "", startedAt: startedAt ?? Date.now(), jobId } }));
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
        setHiddenPending((prev) => {
          if (!prev.has(pageId)) return prev;
          const next = new Set(prev);
          next.delete(pageId);
          return next;
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
        setHiddenPending((prev) => {
          if (!prev.has(pageId)) return prev;
          const next = new Set(prev);
          next.delete(pageId);
          return next;
        });
        setError(event.message);
        setStarting(false);
      } else if (event.type === "cancelled") {
        setPendingReplies((prev) => {
          const { [pageId]: _cancelled, ...rest } = prev;
          return rest;
        });
        setHiddenPending((prev) => {
          if (!prev.has(pageId)) return prev;
          const next = new Set(prev);
          next.delete(pageId);
          return next;
        });
        setStarting(false);
      }
    });
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!draft.trim() || editingPageId) return;

    const content = draft.trim();
    setDraft("");
    setError(null);

    try {
      const genOpts = mode === "play" ? toggles.generationOptions() : undefined;
      const { jobId, agentPageId } =
        mode === "guide"
          ? await postSetupMessage(storyId, content)
          : await postMessage(storyId, content, genOpts);
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
      const genOpts = mode === "play" ? toggles.generationOptions() : undefined;
      const { jobId, agentPageId } = await continuePost(storyId, guidance, genOpts);
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
      const genOpts = mode === "play" ? toggles.generationOptions() : undefined;
      const { jobId } = await retryPost(storyId, pageId, guidance, genOpts);
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

  /** Delegated on .log rather than a per-entry onClick — a per-entry closure prop would defeat
   * EntryContent's React.memo (a new function reference every render forces a re-render
   * regardless of whether content actually changed), which matters here since every streamed
   * token re-renders the whole list via the pendingReplies effect above. */
  function handleLogClick(e: React.MouseEvent<HTMLDivElement>) {
    if (editingPageId || busy) return;
    const contentEl = (e.target as HTMLElement).closest<HTMLElement>(".entry-content");
    if (!contentEl) return;
    const entryEl = contentEl.closest<HTMLElement>(".entry");
    const pageId = entryEl?.dataset.pageId;
    if (!entryEl || !pageId) return;
    const entry = shown.find((en) => en.pageId === pageId);
    if (!entry) return;
    const content = entry.content ?? "";
    const clicked = resolveClickOffset(e.clientX, e.clientY, contentEl);
    pendingCaretRef.current = clicked !== null ? Math.max(0, Math.min(clicked, content.length)) : content.length;
    setEditingPageId(pageId);
    setEditDraft(content);
    setEditInitialHeight(contentEl.offsetHeight);
  }

  function cancelEdit() {
    setEditingPageId(null);
    setEditDraft("");
    setEditInitialHeight(undefined);
    editTextareaRef.current = null;
    pendingCaretRef.current = null;
  }

  async function saveEdit() {
    const pageId = editingPageId;
    if (!pageId) return;
    const entry = shown.find((en) => en.pageId === pageId);
    const changed = !!entry && editDraft !== (entry.content ?? "");
    cancelEdit();
    if (changed) {
      try {
        await editPost(storyId, pageId, editDraft);
        await refresh();
      } catch (err) {
        console.error(err);
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  async function forkFromEdit() {
    const pageId = editingPageId;
    if (!pageId) return;
    cancelEdit();
    await handleFork(pageId);
  }

  /** Performs an actual forward-delete in the single open edit box, bypassing whatever native
   * key-entry UI the platform did or didn't show for the current selection. Routed through
   * execCommand (deprecated but still broadly supported, including Android Chrome) rather than a
   * direct value splice, since only edits made that way register in the browser's own undo stack
   * — a plain state update wouldn't be Ctrl+Z-able the way a real keypress is. */
  function handleDeleteKey() {
    const el = editTextareaRef.current;
    if (!el) return;
    el.focus();
    const hasSelection = el.selectionStart !== el.selectionEnd;
    const handled = document.execCommand(hasSelection ? "delete" : "forwardDelete");
    if (handled) {
      setEditDraft(el.value);
      return;
    }
    // Fallback for environments without execCommand support — same net result, just not undoable.
    const start = el.selectionStart ?? editDraft.length;
    const end = el.selectionEnd ?? editDraft.length;
    const next = start === end ? editDraft.slice(0, start) + editDraft.slice(start + 1) : editDraft.slice(0, start) + editDraft.slice(end);
    setEditDraft(next);
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
   * Every Play→OOC switch post-kickoff marks a fresh session boundary so the Editor's context
   * resets instead of replaying every OOC turn the story has ever had — silently, nothing is
   * added to the log, so there's nothing to refresh. Pre-kickoff setup is already in guide mode
   * by default (from the initial useState above), so this only fires once the story has
   * actually reached story phase.
   */
  async function handleEnterOoc() {
    if (phase !== "setup") {
      try {
        await startOocSession(storyId);
      } catch (err) {
        console.error(err);
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    setMode("guide");
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
  const pendingEntries = entries.filter(
    (e) => pendingIds.has(e.pageId) && (mode === "play" ? !e.hidden : e.hidden) && !hiddenPending.has(e.pageId)
  );

  return (
    <div className="story-view">
      <div className="log" ref={logRef} onClick={handleLogClick}>
        {shown.map((entry) => (
          <div key={entry.pageId} data-page-id={entry.pageId} className={`entry entry-${entry.role}`}>
            <RoleLabel role={entry.role} mode={mode} />
            {entry.pageId === editingPageId ? (
              <>
                <AutoGrowTextarea
                  className="edit-box-textarea"
                  value={editDraft}
                  onChange={setEditDraft}
                  onFocus={(e) => {
                    const el = e.currentTarget;
                    editTextareaRef.current = el;
                    if (pendingCaretRef.current !== null) {
                      el.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current);
                      pendingCaretRef.current = null;
                    }
                  }}
                  initialHeight={editInitialHeight}
                  autoFocus
                />
              </>
            ) : (
              <EntryContent content={entry.content ?? "…"} highlightBlocks={mode === "guide"} />
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
              {pending?.jobId && (
                <button
                  type="button"
                  className="pending-stop-btn"
                  onClick={() =>
                    void cancelJob(storyId, pending.jobId).catch((err) => {
                      // Some job types (Horde, and compress/archive) can't actually be aborted
                      // mid-generation — the route 409s rather than stopping anything. Rather
                      // than leaving the "Thinking…" bubble stuck with a failed stop, hide it
                      // locally; the job keeps running in the background and the reply reappears
                      // on its own once it resolves.
                      console.error(err);
                      setHiddenPending((prev) => new Set(prev).add(entry.pageId));
                      toast.info("Still running in the background — it'll reappear when it finishes.", "Can't stop this job");
                    })
                  }
                >
                  ✕ stop
                </button>
              )}
            </div>
          );
        })}
        <div ref={logEndRef} />
      </div>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button type="button" className="error-banner-dismiss" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className="play-toolbar">
        {editingPageId ? (
          <>
            <button type="button" onClick={() => void saveEdit()}>Save</button>
            <button type="button" onClick={cancelEdit}>Cancel</button>
            <button type="button" onClick={() => void forkFromEdit()}>Fork</button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={handleDeleteKey}>Del</button>
          </>
        ) : (
          <ButtonContainerRow
            storageScope="input"
            containers={toolbarContainers}
            resolveLabel={(id, fallback) => {
              if (id === "toggle.length") return `Length: ${toggles.labels.length}`;
              if (id === "toggle.mood") return `Mood: ${toggles.labels.mood}`;
              if (id === "toggle.param") return `Param: ${toggles.labels.param}`;
              if (id === "toggle.model") return `Model: ${toggles.labels.model}`;
              if (id === "toggle.effort") return `Effort: ${toggles.labels.effort}`;
              return fallback ?? id;
            }}
            getButtonProps={(id) => {
              if (busy && !id.startsWith("mode.")) {
                // mode switches disabled when busy; toggles too
              }
              if (id === "mode.ooc") {
                return {
                  onClick: () => void handleEnterOoc(),
                  active: mode === "guide",
                  disabled: busy || !!editingPageId,
                  className: mode === "guide" ? "active" : undefined,
                };
              }
              if (id === "mode.ic") {
                return {
                  onClick: () => setMode("play"),
                  active: mode === "play",
                  disabled: busy || !!editingPageId,
                  className: mode === "play" ? "active" : undefined,
                };
              }
              if (id === "action.undo") {
                return { onClick: () => void handleUndo(), disabled: busy || !position?.canUndo };
              }
              if (id === "action.redo") {
                return { onClick: () => void handleRedo(), disabled: busy || !position?.canRedo };
              }
              if (id === "action.retry") {
                return {
                  onClick: () => lastEntry && handleRetryClick(lastEntry.pageId),
                  disabled: busy || !canRetry,
                };
              }
              if (id === "action.continue") {
                return { onClick: handleContinueClick, disabled: busy };
              }
              if (id === "toggle.length") {
                return { onClick: toggles.cycleLength, disabled: busy || mode !== "play" };
              }
              if (id === "toggle.mood") {
                return { onClick: toggles.cycleMood, disabled: busy || mode !== "play" };
              }
              if (id === "toggle.param") {
                return { onClick: toggles.cycleParam, disabled: busy || mode !== "play" };
              }
              if (id === "toggle.model") {
                return { onClick: toggles.cycleModel, disabled: busy || mode !== "play" };
              }
              if (id === "toggle.effort") {
                return { onClick: toggles.cycleEffort, disabled: busy || mode !== "play" };
              }
              return null;
            }}
            trailing={
              <>
                {mode === "guide" && phase === "setup" && (
                  <button type="button" onClick={() => void handleKickoff()} disabled={busy || !!editingPageId}>
                    Kickoff →
                  </button>
                )}
                {position && !position.atHead && (
                  <span className="rewind-note">Viewing an earlier point — new posts will branch from here.</span>
                )}
              </>
            }
          />
        )}
      </div>

      <form className="composer" onSubmit={handleSubmit}>
        <AutoGrowTextarea
          value={draft}
          onChange={setDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (editingPageId) return;
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
          disabled={!!editingPageId}
        />
        <button type="submit" disabled={!!editingPageId || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
