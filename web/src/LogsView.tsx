import { Fragment, useEffect, useState } from "react";
import { fetchLog, type LogEntry } from "./api";
import type { PanelProps } from "./panel-types";
import "./LogsView.css";

/** First line only, truncated — the collapsed-row preview. */
function previewText(content: string, max = 120): string {
  const firstLine = content.split("\n")[0] ?? "";
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

export default function LogsView({ story }: PanelProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!story) return;
    void fetchLog(story.id).then(setEntries);
  }, [story]);

  function toggleExpanded(pageId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  }

  function parseMetrics(raw: string | null): { elapsedMs?: number; tokenEstimate?: number } {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  if (!story) return <div className="logs-view">No active story.</div>;

  // buildLogView returns oldest-first (it's also used to render the chat log in reading order) — reverse for display here.
  const mostRecentFirst = [...entries].reverse();

  return (
    <div className="logs-view">
      <h2>Logs</h2>
      <table className="logs-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Role</th>
            <th>Tokens (est.)</th>
            <th>Turnaround</th>
            <th>Compress</th>
            <th>Hidden</th>
          </tr>
        </thead>
        <tbody>
          {mostRecentFirst.map((entry) => {
            const m = parseMetrics(entry.genMetrics);
            const cm = parseMetrics(entry.compressMetrics);
            const content = entry.content ?? "";
            const isExpanded = expanded.has(entry.pageId);
            return (
              <Fragment key={entry.pageId}>
                <tr className={entry.hidden ? "logs-row-hidden" : ""}>
                  <td>{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "—"}</td>
                  <td>{entry.role}</td>
                  <td>{m.tokenEstimate ?? "—"}</td>
                  <td>{m.elapsedMs != null ? `${(m.elapsedMs / 1000).toFixed(1)}s` : "—"}</td>
                  <td>
                    {cm.elapsedMs != null
                      ? `${(cm.elapsedMs / 1000).toFixed(1)}s / ${cm.tokenEstimate ?? "—"}t`
                      : "—"}
                  </td>
                  <td>{entry.hidden ? "yes" : ""}</td>
                </tr>
                <tr className={entry.hidden ? "logs-row-hidden" : ""}>
                  <td colSpan={6} className="logs-content-cell">
                    <button
                      type="button"
                      className={`logs-content-toggle ${isExpanded ? "logs-content-expanded" : "logs-content-collapsed"}`}
                      onClick={() => toggleExpanded(entry.pageId)}
                    >
                      {isExpanded ? content : previewText(content)}
                    </button>
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
