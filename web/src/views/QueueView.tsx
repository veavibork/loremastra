import { useJobs, useSlots, usePanicStopAllJobs } from '../hooks/use-jobs'
import { useNowTick } from '../hooks/use-now-tick'
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
  const panic = usePanicStopAllJobs()

  // The 2s refetch keeps the data fresh, but for a still-running job it returns deep-equal rows
  // that structural sharing collapses to the same reference — so the turnaround clock (a
  // render-time new Date()) never advances without this tick while a job is in flight.
  useNowTick((jobs ?? []).some((j) => j.status === 'running' || j.status === 'pending'))

  if (!story) return <div className="logs-view">No active story.</div>

  function handlePanic() {
    if (
      !confirm(
        'Hard-stop every queued and in-progress job across ALL your stories, right now?\n\n' +
          'This aborts in-flight generations. Featherless may still hold onto a slot for a bit ' +
          'after that for anything it was already mid-generation on — this stops us from waiting ' +
          "on it, but can't force their side to free it instantly.",
      )
    ) {
      return
    }
    panic.mutate()
  }

  return (
    <div className="logs-view">
      <h2>Queue</h2>
      <div className="logs-slots-bar">
        Concurrency slots: {slots ? `${slots.used} / ${slots.max}` : '…'}
        <button
          type="button"
          className="danger logs-panic-button"
          onClick={handlePanic}
          disabled={panic.isPending}
        >
          {panic.isPending ? 'Stopping…' : 'Panic — stop everything'}
        </button>
        {panic.data && (
          <span className="logs-panic-result">
            Aborted {panic.data.aborted}, reaped {panic.data.reaped}
          </span>
        )}
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
