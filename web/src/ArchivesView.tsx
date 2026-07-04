import { useCallback, useEffect, useState } from "react";
import {
  backfillArchiveNames,
  fetchArchives,
  queueArchiveDecad,
  requeueArchive,
  updateArchive,
  type ArchiveEntry,
  type ArchivePage,
} from "./api";
import type { PanelProps } from "./panel-types";
import "./ArchivesView.css";

const POLL_MS = 3000;

function applyPage(setArchives: (a: ArchiveEntry[]) => void, setStats: (s: Omit<ArchivePage, "archives">) => void, page: ArchivePage) {
  setArchives(page.archives);
  setStats({
    total: page.total,
    withSummary: page.withSummary,
    pending: page.pending,
    broken: page.broken,
    missingRows: page.missingRows,
  });
}

/**
 * Scene-wide archive blocks (non-overlapping decads of ~10 posts) — older history in [EVENT SUMMARY] form.
 */
export default function ArchivesView({ story }: PanelProps) {
  const [archives, setArchives] = useState<ArchiveEntry[]>([]);
  const [stats, setStats] = useState({ total: 0, withSummary: 0, pending: 0, broken: 0, missingRows: 0 });
  const [includeHidden, setIncludeHidden] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (background = false) => {
      if (!story) return;
      const page = await fetchArchives(story.id, { includeHidden, background });
      applyPage(setArchives, setStats, page);
    },
    [story, includeHidden]
  );

  useEffect(() => {
    if (!story) return;
    void (async () => {
      try {
        const page = await backfillArchiveNames(story.id);
        applyPage(setArchives, setStats, page);
      } catch {
        await refresh();
      }
    })();
    const interval = setInterval(() => void refresh(true), POLL_MS);
    return () => clearInterval(interval);
  }, [story, includeHidden, refresh]);

  function cardKey(archive: ArchiveEntry): string {
    return archive.id ?? `missing-${archive.startIndex}`;
  }

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function runAction(key: string, fn: () => Promise<ArchivePage>) {
    setBusyKey(key);
    setError(null);
    try {
      const page = await fn();
      applyPage(setArchives, setStats, page);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  function startEdit(archive: ArchiveEntry) {
    if (!archive.id) return;
    setEditingId(archive.id);
    setEditDraft(archive.summary ?? "");
    setExpanded((prev) => new Set(prev).add(cardKey(archive)));
  }

  async function saveEdit(archiveId: string) {
    if (!story) return;
    await runAction(archiveId, () => updateArchive(story.id, archiveId, { summary: editDraft }));
    setEditingId(null);
  }

  if (!story) return <div className="archives-view">No active story.</div>;

  return (
    <div className="archives-view">
      <div className="archives-header">
        <h2>Archives</h2>
        <label className="archives-hidden-toggle">
          <input
            type="checkbox"
            checked={includeHidden}
            onChange={(e) => setIncludeHidden(e.target.checked)}
          />
          Show hidden
        </label>
      </div>
      {error && <p className="archives-error">{error}</p>}
      {stats.total === 0 && <p className="archives-empty">No archive blocks yet — need 10 posts per window.</p>}
      {stats.total > 0 && (
        <p className="archives-count">
          {stats.withSummary} of {stats.total} blocks summarized
          {stats.pending > 0 && ` — ${stats.pending} pending`}
          {stats.missingRows > 0 && ` — ${stats.missingRows} missing row`}
          {stats.broken > 0 && ` — ${stats.broken} broken (need regen)`}
          {!includeHidden && " · in-character only"}
        </p>
      )}
      <div className="archives-list">
        {archives.map((archive) => {
          const key = cardKey(archive);
          const isExpanded = expanded.has(key);
          const rangeLabel = archive.name?.trim()
            ? archive.name
            : `posts ${archive.startIndex + 1}–${archive.endIndex + 1}`;
          const statusLabel =
            archive.status === "missing"
              ? "archive pending"
              : archive.status === "ready"
                ? "ready"
                : archive.status === "broken"
                  ? "broken"
                  : archive.archiveJobActive
                    ? "archiving"
                    : "pending";
          const showQueue =
            (archive.status === "missing" || archive.status === "pending" || archive.status === "broken") &&
            !archive.archiveJobActive &&
            archive.queueEligible;
          const showRequeue = archive.id && (archive.status === "ready" || archive.status === "broken");
          const showEdit = archive.id && archive.status === "ready";

          return (
            <article
              key={key}
              className={`archive-card archive-${archive.status}${archive.hidden ? " archive-row-hidden" : ""}`}
            >
              <header className="archive-card-header">
                <button type="button" className="archive-toggle" onClick={() => toggleExpanded(key)}>
                  <span className="archive-range">{rangeLabel}</span>
                  <span className="archive-meta">
                    {archive.name ? `${archive.startIndex + 1}–${archive.endIndex + 1} · ` : ""}
                    {archive.memberCount > 0 && `${archive.memberCount} posts · `}
                    {archive.createdAt && `${new Date(archive.createdAt).toLocaleString()} · `}
                    {archive.nameJobActive && "naming… · "}
                    {archive.hidden && "hidden · "}
                    {archive.broken && "broken"}
                  </span>
                </button>
                <span className={`archive-status archive-status-${archive.status}`}>{statusLabel}</span>
              </header>

              <div className="archive-actions">
                {showQueue && (
                  <button
                    type="button"
                    disabled={busyKey === key}
                    onClick={() => void runAction(key, () => queueArchiveDecad(story.id, archive.startIndex))}
                  >
                    Queue
                  </button>
                )}
                {showEdit && (
                  <button type="button" disabled={busyKey === key} onClick={() => startEdit(archive)}>
                    Edit
                  </button>
                )}
                {showRequeue && archive.id && (
                  <button
                    type="button"
                    disabled={busyKey === key}
                    onClick={() => void runAction(key, () => requeueArchive(story.id, archive.id!))}
                  >
                    Requeue
                  </button>
                )}
                {!archive.queueEligible && archive.status === "missing" && (
                  <span className="archive-hint">Waiting on prose in all 10 posts</span>
                )}
              </div>

              {isExpanded && (
                <div className="archive-body">
                  {editingId === archive.id ? (
                    <>
                      <textarea
                        className="archive-edit"
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        rows={6}
                      />
                      <div className="archive-edit-actions">
                        <button type="button" onClick={() => void saveEdit(archive.id!)} disabled={busyKey === archive.id}>
                          Save
                        </button>
                        <button type="button" onClick={() => setEditingId(null)}>
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className={`archive-summary${archive.summary ? "" : " archive-pending"}`}>
                      {archive.summary ??
                        (archive.status === "missing"
                          ? "— no archive row yet —"
                          : "— pending archive job —")}
                    </p>
                  )}
                  <p className="archive-ids">
                    <span>{archive.startPageId.slice(0, 8)}…</span>
                    <span> → </span>
                    <span>{archive.endPageId.slice(0, 8)}…</span>
                  </p>
                </div>
              )}
              {!isExpanded && archive.summary && (
                <p className="archive-preview">
                  {archive.summary.length > 160 ? `${archive.summary.slice(0, 160)}…` : archive.summary}
                </p>
              )}
              {!isExpanded && !archive.summary && (
                <p className="archive-preview archive-pending">
                  {archive.status === "missing" ? "— archive pending —" : "— pending —"}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
