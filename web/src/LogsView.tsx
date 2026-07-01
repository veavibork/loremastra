import { useEffect, useState } from "react";
import { fetchLog, type LogEntry } from "./api";
import type { PanelProps } from "./panel-types";
import "./LogsView.css";

export default function LogsView({ story }: PanelProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useEffect(() => {
    if (!story) return;
    void fetchLog(story.id).then(setEntries);
  }, [story]);

  function metrics(entry: LogEntry): { elapsedMs?: number; tokenEstimate?: number } {
    if (!entry.genMetrics) return {};
    try {
      return JSON.parse(entry.genMetrics);
    } catch {
      return {};
    }
  }

  if (!story) return <div className="logs-view">No active story.</div>;

  return (
    <div className="logs-view">
      <h2>Logs</h2>
      <table className="logs-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Role</th>
            <th>Content</th>
            <th>Tokens (est.)</th>
            <th>Turnaround</th>
            <th>Hidden</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const m = metrics(entry);
            return (
              <tr key={entry.pageId} className={entry.hidden ? "logs-row-hidden" : ""}>
                <td>{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "—"}</td>
                <td>{entry.role}</td>
                <td className="logs-content">{entry.content ?? ""}</td>
                <td>{m.tokenEstimate ?? "—"}</td>
                <td>{m.elapsedMs != null ? `${(m.elapsedMs / 1000).toFixed(1)}s` : "—"}</td>
                <td>{entry.hidden ? "yes" : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
