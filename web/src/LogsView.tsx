import { Fragment, useEffect, useState } from "react";
import { fetchJobs, fetchLog, fetchSlots, type Job, type LogEntry } from "./api";
import type { PanelProps } from "./panel-types";
import "./LogsView.css";

/** First line only, truncated — the collapsed-row preview. */
function previewText(content: string, max = 120): string {
  const firstLine = content.split("\n")[0] ?? "";
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

function parseMetrics(raw: string | null): { elapsedMs?: number; tokenEstimate?: number } {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function jobElapsed(job: Job): string {
  if (job.elapsedMs != null) return `${(job.elapsedMs / 1000).toFixed(1)}s`;
  return turnaround(job);
}

function turnaround(job: Job): string {
  if (!job.startedAt) return "—";
  const end = job.finishedAt ? new Date(job.finishedAt) : new Date();
  const start = new Date(job.startedAt);
  return `${((end.getTime() - start.getTime()) / 1000).toFixed(1)}s`;
}

function jobResponse(job: Job): string {
  if (job.status === "failed") return job.error ? `error — ${job.error}` : "error";
  if (job.status === "done") return "200 OK";
  if (job.status === "cancelled") return "cancelled";
  return "—";
}

export default function LogsView({ story }: PanelProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [slots, setSlots] = useState<{ used: number; max: number } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!story) return;
    let cancelled = false;

    async function poll(opts?: { background?: boolean }) {
      if (!story) return;
      const [logEntries, j, s] = await Promise.all([
        fetchLog(story.id, opts),
        fetchJobs(story.id, opts),
        fetchSlots(opts),
      ]);
      if (!cancelled) {
        setEntries(logEntries);
        setJobs(j);
        setSlots(s);
      }
    }

    void poll();
    const interval = setInterval(() => void poll({ background: true }), 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [story]);

  function toggleExpanded(pageId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  }

  if (!story) return <div className="logs-view">No active story.</div>;

  const mostRecentFirst = [...entries].reverse();

  return (
    <div className="logs-view">
      <h2>Logs</h2>

      <section className="logs-section">
        <h3 className="logs-section-title">Queue</h3>
        <div className="logs-slots-bar">
          Concurrency slots: {slots ? `${slots.used} / ${slots.max}` : "…"}
        </div>
        <table className="logs-table logs-jobs-table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Type</th>
              <th>Status</th>
              <th>Model</th>
              <th>Tokens</th>
              <th>Priority</th>
              <th>Cost</th>
              <th>Turnaround</th>
              <th>Response</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} className={`logs-job-row logs-job-${job.status}`}>
                <td>{new Date(job.createdAt).toLocaleString()}</td>
                <td>{job.jobType}</td>
                <td>{job.status}</td>
                <td className="logs-job-model">{job.model ?? "—"}</td>
                <td>{job.tokenEstimate ?? "—"}</td>
                <td>{job.priority}</td>
                <td>{job.slotCost}</td>
                <td>{jobElapsed(job)}</td>
                <td className={`logs-job-response ${job.status === "failed" ? "logs-job-response-error" : ""}`}>
                  {jobResponse(job)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="logs-section">
        <h3 className="logs-section-title">Posts</h3>
        <table className="logs-table">
          <thead>
            <tr>
              <th title="Absolute post number from kickoff (hidden turns count)">Post #</th>
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
                    <td>{entry.icPostNumber ?? "—"}</td>
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
                    <td colSpan={7} className="logs-content-cell">
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
      </section>
    </div>
  );
}
