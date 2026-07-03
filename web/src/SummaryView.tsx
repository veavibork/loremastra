import { useCallback, useEffect, useState } from "react";
import { fetchSummaries, type LogEntry } from "./api";
import type { PanelProps } from "./panel-types";
import "./SummaryView.css";

/** Polls on a short interval — compress jobs finish in the background while this tab sits open. */
const POLL_MS = 3000;

/**
 * One row per in-character post — compressed summary when available, pending otherwise.
 * Loads the full log in one request (stories are hundreds of posts, not thousands).
 */
export default function SummaryView({ story }: PanelProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [compressedCount, setCompressedCount] = useState(0);
  const [includeHidden, setIncludeHidden] = useState(false);

  const refresh = useCallback(
    async (background = false) => {
      if (!story) return;
      const page = await fetchSummaries(story.id, { includeHidden, background });
      setEntries(page.entries);
      setTotal(page.total);
      setCompressedCount(page.entries.filter((e) => e.genExtract != null).length);
    },
    [story, includeHidden]
  );

  useEffect(() => {
    if (!story) return;
    void refresh();
    const interval = setInterval(() => void refresh(true), POLL_MS);
    return () => clearInterval(interval);
  }, [story, includeHidden, refresh]);

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
      {total === 0 && <p className="summary-empty">No posts yet.</p>}
      {total > 0 && (
        <p className="summary-count">
          {compressedCount} of {total} posts compressed
          {compressedCount < total && ` — ${total - compressedCount} pending`}
          {!includeHidden && " · in-character only (toggle Show hidden for setup/OOC)"}
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
              <td className={`summary-content ${entry.genExtract ? "" : "summary-pending"}`}>
                {entry.genExtract ?? "— pending —"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
