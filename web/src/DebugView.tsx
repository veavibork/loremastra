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

    async function poll() {
      if (!story) return;
      const [j, s] = await Promise.all([fetchJobs(story.id), fetchSlots()]);
      if (!cancelled) {
        setJobs(j);
        setSlots(s);
      }
    }

    void poll();
    const interval = setInterval(poll, 2000);
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
            <th>Priority</th>
            <th>Cost</th>
            <th>Turnaround</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className={`job-row job-${job.status}`}>
              <td>{job.jobType}</td>
              <td>{job.status}</td>
              <td>{job.priority}</td>
              <td>{job.slotCost}</td>
              <td>{turnaround(job)}</td>
              <td className="job-error">{job.error ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
