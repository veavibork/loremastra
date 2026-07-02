import { useEffect, useState } from "react";
import { fetchJobs, fetchSlots, type Job } from "./api";
import type { PanelProps } from "./panel-types";
import "./DebugView.css";

export default function DebugView({ story }: PanelProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [slots, setSlots] = useState<{ used: number; max: number } | null>(null);

  useEffect(() => {
    if (!story) return;
    let cancelled = false;

    async function poll(opts?: { background?: boolean }) {
      if (!story) return;
      const [j, s] = await Promise.all([fetchJobs(story.id, opts), fetchSlots(opts)]);
      if (!cancelled) {
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

  function turnaround(job: Job): string {
    if (!job.startedAt) return "—";
    const end = job.finishedAt ? new Date(job.finishedAt) : new Date();
    const start = new Date(job.startedAt);
    return `${((end.getTime() - start.getTime()) / 1000).toFixed(1)}s`;
  }

  /** A status/description regardless of outcome, not just blank when nothing went wrong. */
  function response(job: Job): string {
    if (job.status === "failed") return job.error ? `error — ${job.error}` : "error";
    if (job.status === "done") return "200 OK";
    if (job.status === "cancelled") return "cancelled";
    return "—";
  }

  if (!story) return <div className="debug-view">No active story.</div>;

  return (
    <div className="debug-view">
      <h2>Debug</h2>
      <div className="slots-bar">
        Concurrency slots: {slots ? `${slots.used} / ${slots.max}` : "…"}
      </div>

      <table className="jobs-table">
        <thead>
          <tr>
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
            <tr key={job.id} className={`job-row job-${job.status}`}>
              <td>{job.jobType}</td>
              <td>{job.status}</td>
              <td className="job-model">{job.model ?? "—"}</td>
              <td>{job.tokenEstimate ?? "—"}</td>
              <td>{job.priority}</td>
              <td>{job.slotCost}</td>
              <td>{turnaround(job)}</td>
              <td className={`job-response ${job.status === "failed" ? "job-response-error" : ""}`}>{response(job)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
