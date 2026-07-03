import { useEffect, useState } from "react";
import { fetchLog, type LogEntry } from "./api";
import type { PanelProps } from "./panel-types";
import "./SummaryView.css";

/** Polls on a short interval — compress jobs finish in the background while this tab sits open, with no local action to hook a one-off refresh onto (same reasoning as WorldbookView). */
const POLL_MS = 3000;

/**
 * The rolling compressed log: one dense line per post once it's aged past the compression lag
 * (see src/services/compression.ts), most recent first — this is what the Author actually reads
 * as history once a post scrolls out of the verbatim window, so it's the most useful "did
 * compression produce something sane" view. Posts that haven't been compressed yet (still within
 * the lag window, or the job hasn't run) simply don't show up here yet.
 */
export default function SummaryView({ story }: PanelProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useEffect(() => {
    if (!story) return;
    void fetchLog(story.id).then(setEntries);
    const interval = setInterval(() => void fetchLog(story.id, { background: true }).then(setEntries), POLL_MS);
    return () => clearInterval(interval);
  }, [story]);

  if (!story) return <div className="summary-view">No active story.</div>;

  // buildLogView returns oldest-first — reverse for most-recent-first display.
  const compressed = entries.filter((e) => e.genExtract != null).reverse();

  return (
    <div className="summary-view">
      <h2>Summary</h2>
      {compressed.length === 0 && <p className="summary-empty">Nothing compressed yet.</p>}
      <table className="summary-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Role</th>
            <th>Compressed summary</th>
          </tr>
        </thead>
        <tbody>
          {compressed.map((entry) => (
            <tr key={entry.pageId} className={entry.hidden ? "summary-row-hidden" : ""}>
              <td>{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "—"}</td>
              <td>{entry.role}</td>
              <td className="summary-content">{entry.genExtract}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
