import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSummaries, type LogEntry } from "./api";
import type { PanelProps } from "./panel-types";
import "./SummaryView.css";

/** Polls on a short interval — compress jobs finish in the background while this tab sits open. */
const POLL_MS = 3000;
const PAGE_SIZE = 50;

/**
 * Rolling compressed log — one dense line per post once compressed. Paginated most-recent-first
 * with infinite scroll to load older summaries; hidden setup/OOC entries excluded by default.
 */
export default function SummaryView({ story }: PanelProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const loadedCountRef = useRef(0);

  const refresh = useCallback(
    async (background = false) => {
      if (!story) return;
      const limit = Math.max(loadedCountRef.current || PAGE_SIZE, PAGE_SIZE);
      const page = await fetchSummaries(story.id, { offset: 0, limit, includeHidden, background });
      loadedCountRef.current = page.entries.length;
      setTotal(page.total);
      setHasMore(page.hasMore);
      setEntries(page.entries);
    },
    [story, includeHidden]
  );

  const loadMore = useCallback(async () => {
    if (!story || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchSummaries(story.id, {
        offset: entries.length,
        limit: PAGE_SIZE,
        includeHidden,
      });
      loadedCountRef.current = entries.length + page.entries.length;
      setTotal(page.total);
      setHasMore(page.hasMore);
      setEntries((prev) => [...prev, ...page.entries]);
    } finally {
      setLoadingMore(false);
    }
  }, [story, includeHidden, loadingMore, hasMore, entries.length]);

  useEffect(() => {
    if (!story) return;
    loadedCountRef.current = 0;
    void refresh();
    const interval = setInterval(() => void refresh(true), POLL_MS);
    return () => clearInterval(interval);
  }, [story, includeHidden, refresh]);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !hasMore || loadingMore) return;

    const observer = new IntersectionObserver(
      (hits) => {
        if (hits[0]?.isIntersecting) void loadMore();
      },
      { rootMargin: "120px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMore, loadingMore]);

  if (!story) return <div className="summary-view">No active story.</div>;

  return (
    <div className="summary-view">
      <div className="summary-header">
        <h2>Summary</h2>
        <label className="summary-hidden-toggle">
          <input
            type="checkbox"
            checked={includeHidden}
            onChange={(e) => setIncludeHidden(e.target.checked)}
          />
          Show hidden
        </label>
      </div>
      {total === 0 && <p className="summary-empty">Nothing compressed yet.</p>}
      {total > 0 && (
        <p className="summary-count">
          Showing {entries.length} of {total} compressed {total === 1 ? "post" : "posts"}
          {!includeHidden && " (in-character only)"}
        </p>
      )}
      <table className="summary-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Role</th>
            <th>Compressed summary</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.pageId} className={entry.hidden ? "summary-row-hidden" : ""}>
              <td>{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "—"}</td>
              <td>{entry.role}</td>
              <td className="summary-content">{entry.genExtract}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hasMore && (
        <div ref={loadMoreRef} className="summary-load-more">
          {loadingMore ? "Loading older summaries…" : "Scroll for older summaries"}
        </div>
      )}
    </div>
  );
}
