import { useCallback, useEffect, useState } from "react";
import {
  backfillStoryToDateNames,
  cancelJob,
  deleteStoryToDateSegment,
  enqueueStoryToDate,
  fetchStoryToDate,
  requeueStoryToDateSegment,
  updateStoryToDateSegment,
  type ActiveMemoryJob,
  type StoryToDatePage,
  type StoryToDateSegment,
} from "./api";
import type { PanelProps } from "./panel-types";
import "./ArchivesView.css";

const POLL_MS = 3000;

function applyPage(
  setSegments: (s: StoryToDateSegment[]) => void,
  setStats: (s: Omit<StoryToDatePage, "segments" | "activeMemoryJobs">) => void,
  setActiveMemoryJobs: (jobs: ActiveMemoryJob[]) => void,
  page: StoryToDatePage
) {
  setSegments(page.segments);
  setActiveMemoryJobs(page.activeMemoryJobs ?? []);
  setStats({
    mergedCoverageThroughPost: page.mergedCoverageThroughPost,
    icPostCount: page.icPostCount ?? 0,
    total: page.total,
    withContent: page.withContent,
    pending: page.pending,
    broken: page.broken,
  });
}

function segmentLabel(seg: StoryToDateSegment): string {
  if (seg.name?.trim()) return seg.name;
  const kind = seg.kind === "begins" ? "Story begins" : "Story continues";
  if (seg.coverageThroughIcPost != null) {
    return `${kind} · through post ${seg.coverageThroughIcPost}`;
  }
  return `${kind} · seq ${seg.seq}`;
}

function memoryJobLabel(job: ActiveMemoryJob): string {
  if (job.jobType === "story-to-date-fold") return "Folding older memory";
  if (job.jobType === "story-to-date") return "Compressing story memory";
  if (job.jobType === "archive-name") return "Naming segment";
  return job.jobType;
}

function memoryJobElapsed(job: ActiveMemoryJob): string {
  const anchor = job.startedAt ?? job.createdAt;
  const sec = Math.max(0, Math.floor((Date.now() - new Date(anchor).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

/**
 * [STORY TO DATE] segments — collapse/expand, edit, and optional scene titles (Archives tab only).
 */
export default function ArchivesView({ story }: PanelProps) {
  const [segments, setSegments] = useState<StoryToDateSegment[]>([]);
  const [activeMemoryJobs, setActiveMemoryJobs] = useState<ActiveMemoryJob[]>([]);
  const [stats, setStats] = useState({
    mergedCoverageThroughPost: null as number | null,
    icPostCount: 0,
    total: 0,
    withContent: 0,
    pending: 0,
    broken: 0,
  });
  const [includeHidden, setIncludeHidden] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [coverageDraft, setCoverageDraft] = useState<string>("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (background = false) => {
      if (!story) return;
      const page = await fetchStoryToDate(story.id, { background });
      applyPage(setSegments, setStats, setActiveMemoryJobs, page);
    },
    [story]
  );

  useEffect(() => {
    if (!story) return;
    void (async () => {
      try {
        const page = await backfillStoryToDateNames(story.id);
        applyPage(setSegments, setStats, setActiveMemoryJobs, page);
      } catch {
        await refresh();
      }
    })();
    const interval = setInterval(() => void refresh(true), POLL_MS);
    return () => clearInterval(interval);
  }, [story, refresh]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runAction(key: string, fn: () => Promise<StoryToDatePage>) {
    setBusyKey(key);
    setError(null);
    try {
      const page = await fn();
      applyPage(setSegments, setStats, setActiveMemoryJobs, page);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  function startEdit(seg: StoryToDateSegment) {
    setEditingId(seg.id);
    setEditDraft(seg.content ?? "");
    setCoverageDraft(seg.coverageThroughIcPost != null ? String(seg.coverageThroughIcPost) : "");
    setExpanded((prev) => new Set(prev).add(seg.id));
  }

  async function saveEdit(segmentId: string) {
    if (!story) return;
    const coverageThroughIcPost = coverageDraft.trim() ? Number(coverageDraft.trim()) : undefined;
    if (coverageThroughIcPost !== undefined && (!Number.isFinite(coverageThroughIcPost) || coverageThroughIcPost <= 0)) {
      setError("Coverage must be a positive post number");
      return;
    }
    await runAction(segmentId, () =>
      updateStoryToDateSegment(story.id, segmentId, {
        content: editDraft,
        ...(coverageThroughIcPost !== undefined ? { coverageThroughIcPost } : {}),
      })
    );
    setEditingId(null);
  }

  if (!story) return <div className="archives-view">No active story.</div>;

  const visible = includeHidden ? segments : segments.filter((s) => !s.hidden);

  return (
    <div className="archives-view">
      <div className="archives-header">
        <h2>Archives</h2>
        <div className="archives-header-actions">
          <button
            type="button"
            disabled={!!busyKey}
            onClick={() => void runAction("enqueue", () => enqueueStoryToDate(story.id))}
          >
            Queue job
          </button>
          <label className="archives-hidden-toggle">
            <input
              type="checkbox"
              checked={includeHidden}
              onChange={(e) => setIncludeHidden(e.target.checked)}
            />
            Show hidden
          </label>
        </div>
      </div>

      {error && <p className="archives-error">{error}</p>}
      {activeMemoryJobs.length > 0 && (
        <div className="archives-active-jobs">
          {activeMemoryJobs.map((job) => (
            <div key={job.id} className="archives-active-job">
              <span>
                {memoryJobLabel(job)} ({job.status}, {memoryJobElapsed(job)})
              </span>
              <button
                type="button"
                className="archives-cancel-job"
                disabled={busyKey === job.id}
                onClick={() =>
                  void (async () => {
                    if (!story) return;
                    setBusyKey(job.id);
                    setError(null);
                    try {
                      await cancelJob(story.id, job.id);
                      await refresh(true);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err));
                    } finally {
                      setBusyKey(null);
                    }
                  })()
                }
              >
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}
      {stats.total === 0 && (
        <p className="archives-empty">No [STORY TO DATE] segments yet — queue a job or keep playing.</p>
      )}
      {stats.total > 0 && (
        <p className="archives-count">
          {stats.withContent} of {stats.total} segments ready
          {stats.pending > 0 && ` — ${stats.pending} pending`}
          {stats.broken > 0 && ` — ${stats.broken} broken`}
          {stats.mergedCoverageThroughPost != null && ` · archive through post ${stats.mergedCoverageThroughPost}`}
          {stats.icPostCount > 0 && ` · ${stats.icPostCount} posts on chain`}
        </p>
      )}

      <div className="archives-list">
        {visible.map((seg) => {
          const isExpanded = expanded.has(seg.id);
          const statusLabel =
            seg.status === "ready"
              ? seg.foldJobActive
                ? "folding"
                : "ready"
              : seg.status === "broken"
                ? "broken"
                : seg.jobActive
                  ? "generating"
                  : "pending";
          const showRequeue = seg.status === "pending" && !seg.jobActive;
          const showEdit = seg.status === "ready";

          return (
            <article
              key={seg.id}
              className={`archive-card archive-${seg.status}${seg.hidden ? " archive-row-hidden" : ""}`}
            >
              <header className="archive-card-header">
                <button type="button" className="archive-toggle" onClick={() => toggleExpanded(seg.id)}>
                  <span className="archive-range">{segmentLabel(seg)}</span>
                  <span className="archive-meta">
                    [{seg.kind}] seq {seg.seq}
                    {seg.coverageThroughIcPost != null && ` · through post ${seg.coverageThroughIcPost}`}
                    {seg.tokenCount != null && ` · ~${seg.tokenCount.toLocaleString()} tok`}
                    {seg.createdAt && ` · ${new Date(seg.createdAt).toLocaleString()}`}
                    {seg.nameJobActive && " · naming…"}
                    {seg.foldJobActive && " · folding…"}
                    {seg.jobActive && " · generating…"}
                    {seg.hidden && " · hidden"}
                  </span>
                </button>
                <span className={`archive-status archive-status-${seg.status}`}>{statusLabel}</span>
              </header>

              <div className="archive-actions">
                {showRequeue && (
                  <button
                    type="button"
                    disabled={busyKey === seg.id}
                    onClick={() => void runAction(seg.id, () => requeueStoryToDateSegment(story.id, seg.id))}
                  >
                    Requeue
                  </button>
                )}
                {showEdit && (
                  <button type="button" disabled={busyKey === seg.id} onClick={() => startEdit(seg)}>
                    Edit
                  </button>
                )}
                {seg.status === "ready" && (
                  <button
                    type="button"
                    className="danger"
                    disabled={busyKey === seg.id}
                    onClick={() => setConfirmDeleteId(seg.id)}
                  >
                    Delete
                  </button>
                )}
              </div>

              {confirmDeleteId === seg.id && (
                <div className="archive-delete-confirm">
                  <span>Remove this archive segment? Verbose posts it covered return to the Author prompt.</span>
                  <button
                    type="button"
                    className="danger"
                    disabled={busyKey === seg.id}
                    onClick={() =>
                      void runAction(`del-${seg.id}`, () => deleteStoryToDateSegment(story.id, seg.id)).then(() =>
                        setConfirmDeleteId(null)
                      )
                    }
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    disabled={busyKey === seg.id}
                    onClick={() =>
                      void runAction(`del-${seg.id}`, () =>
                        deleteStoryToDateSegment(story.id, seg.id, { deleteLater: true })
                      ).then(() => setConfirmDeleteId(null))
                    }
                  >
                    Delete + later segments
                  </button>
                  <button type="button" onClick={() => setConfirmDeleteId(null)}>
                    Cancel
                  </button>
                </div>
              )}

              {isExpanded && (
                <div className="archive-body">
                  {editingId === seg.id ? (
                    <>
                      <label className="archive-coverage-edit">
                        Coverage through IC post{" "}
                        <input
                          type="number"
                          min={1}
                          value={coverageDraft}
                          onChange={(e) => setCoverageDraft(e.target.value)}
                        />
                      </label>
                      <textarea
                        className="archive-edit"
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        rows={8}
                      />
                      <div className="archive-edit-actions">
                        <button
                          type="button"
                          onClick={() => void saveEdit(seg.id)}
                          disabled={busyKey === seg.id}
                        >
                          Save
                        </button>
                        <button type="button" onClick={() => setEditingId(null)}>
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className={`archive-summary${seg.content ? "" : " archive-pending"}`}>
                      {seg.content ?? "— pending story-to-date job —"}
                    </p>
                  )}
                  {seg.coveragePageId && (
                    <p className="archive-ids">
                      <span>Coverage page {seg.coveragePageId.slice(0, 8)}…</span>
                    </p>
                  )}
                </div>
              )}

              {!isExpanded && seg.content && (
                <p className="archive-preview">
                  {seg.content.length > 160 ? `${seg.content.slice(0, 160)}…` : seg.content}
                </p>
              )}
              {!isExpanded && !seg.content && (
                <p className="archive-preview archive-pending">— pending —</p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
