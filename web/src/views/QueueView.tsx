import { useJobs, useSlots } from '../hooks/use-jobs'
import type { Job } from '../api'
import type { PanelProps } from '../lib/panel-types'
import './LogsView.css'

function jobElapsed(job: Job): string {
  if (job.elapsedMs != null) return `${(job.elapsedMs / 1000).toFixed(1)}s`
  if (!job.startedAt) return '—'
  const end = job.finishedAt ? new Date(job.finishedAt) : new Date()
  const start = new Date(job.startedAt)
  return `${((end.getTime() - start.getTime()) / 1000).toFixed(1)}s`
}

function jobResponse(job: Job): string {
  if (job.status === 'failed') return job.error ? `error — ${job.error}` : 'error'
  if (job.status === 'done' && job.resultSummary) return job.resultSummary
  if (job.status === 'done') return '200 OK'
  if (job.status === 'cancelled') return 'cancelled'
  return '—'
}

export default function QueueView({ story }: PanelProps) {
  const { data: jobs } = useJobs(story?.id ?? null, { background: true, refetchInterval: 2000 })
  const { data: slots } = useSlots({ background: true, refetchInterval: 2000 })

  if (!story) return <div className="logs-view">No active story.</div>

  return (
    <div className="logs-view">
      <h2>Queue</h2>
      <div className="logs-slots-bar">
        Concurrency slots: {slots ? `${slots.used} / ${slots.max}` : '…'}
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
          {(jobs ?? []).map((job) => (
            <tr key={job.id} className={`logs-job-row logs-job-${job.status}`}>
              <td>{new Date(job.createdAt).toLocaleString()}</td>
              <td>{job.jobType}</td>
              <td>{job.status}</td>
              <td className="logs-job-model">{job.model ?? '—'}</td>
              <td>{job.tokenEstimate ?? '—'}</td>
              <td>{job.priority}</td>
              <td>{job.slotCost}</td>
              <td>{jobElapsed(job)}</td>
              <td
                className={`logs-job-response ${job.status === 'failed' ? 'logs-job-response-error' : ''}`}
              >
                {jobResponse(job)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
