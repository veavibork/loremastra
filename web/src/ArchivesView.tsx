import { useCallback, useEffect, useState } from "react";
import { fetchArchives, type ArchiveEntry } from "./api";
import type { PanelProps } from "./panel-types";
import "./ArchivesView.css";

const POLL_MS = 3000;

/**
 * Scene-wide archive blocks (~10-post windows, 50% overlap) — the tier the Author reads
 * once posts scroll out of the verbose window. Most recent block first.
 */
export default function ArchivesView({ story }: PanelProps) {
  const [archives, setArchives] = useState<ArchiveEntry[]>([]);
  const [stats, setStats] = useState({ total: 0, withSummary: 0, pending: 0, broken: 0 });
  const [includeHidden, setIncludeHidden] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(
    async (background = false) => {
      if (!story) return;
      const page = await fetchArchives(story.id, { includeHidden, background });
      setArchives(page.archives);
      setStats({
        total: page.total,
        withSummary: page.withSummary,
        pending: page.pending,
        broken: page.broken,
      });
    },
    [story, includeHidden]
  );

  useEffect(() => {
    if (!story) return;
    void refresh();
    const interval = setInterval(() => void refresh(true), POLL_MS);
    return () => clearInterval(interval);
  }, [story, includeHidden, refresh]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
      {stats.total === 0 && <p className="archives-empty">No archive blocks yet — need 10 posts per window.</p>}
      {stats.total > 0 && (
        <p className="archives-count">
          {stats.withSummary} of {stats.total} blocks summarized
          {stats.pending > 0 && ` — ${stats.pending} pending`}
          {stats.broken > 0 && ` — ${stats.broken} broken (need regen)`}
          {!includeHidden && " · in-character only"}
        </p>
      )}
      <div className="archives-list">
        {archives.map((archive) => {
          const isExpanded = expanded.has(archive.id);
          const rangeLabel = `posts ${archive.startIndex + 1}–${archive.endIndex + 1}`;
          const status = archive.broken ? "broken" : archive.summary ? "ready" : "pending";
          return (
            <article
              key={archive.id}
              className={`archive-card archive-${status}${archive.hidden ? " archive-row-hidden" : ""}`}
            >
              <header className="archive-card-header">
                <button type="button" className="archive-toggle" onClick={() => toggleExpanded(archive.id)}>
                  <span className="archive-range">{rangeLabel}</span>
                  <span className="archive-meta">
                    {archive.memberCount} posts · {new Date(archive.createdAt).toLocaleString()}
                    {archive.broken && " · broken"}
                    {archive.hidden && " · hidden"}
                  </span>
                </button>
                <span className={`archive-status archive-status-${status}`}>{status}</span>
              </header>
              {isExpanded && (
                <div className="archive-body">
                  <p className={`archive-summary${archive.summary ? "" : " archive-pending"}`}>
                    {archive.summary ?? "— pending archive job —"}
                  </p>
                  <p className="archive-ids">
                    <span>{archive.startPageId.slice(0, 8)}…</span>
                    <span> → </span>
                    <span>{archive.endPageId.slice(0, 8)}…</span>
                  </p>
                </div>
              )}
              {!isExpanded && archive.summary && (
                <p className="archive-preview">{archive.summary.length > 160 ? `${archive.summary.slice(0, 160)}…` : archive.summary}</p>
              )}
              {!isExpanded && !archive.summary && <p className="archive-preview archive-pending">— pending —</p>}
            </article>
          );
        })}
      </div>
    </div>
  );
}
