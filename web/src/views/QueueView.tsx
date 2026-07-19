import { useJobs, useSlots, usePanicStopAllJobs } from '../hooks/use-jobs'
import { useNowTick } from '../hooks/use-now-tick'
import type { Job, SlotHolder } from '../api'
import type { PanelProps } from '../lib/panel-types'
import './QueueView.css'

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

function holderAge(holder: SlotHolder): string {
  return `${Math.max(0, Math.round((Date.now() - holder.reservedAt) / 1000))}s`
}

export default function QueueView({ story }: PanelProps) {
  const { data: jobs } = useJobs(story?.id ?? null, { background: true, refetchInterval: 2000 })
  const { data: slots } = useSlots({ background: true, refetchInterval: 2000 })
  const panic = usePanicStopAllJobs()

  const holders = slots?.holders ?? []
  // Featherless usage no local reservation accounts for — a just-aborted call its side still
  // counts, or an in-job retry. This is the previously invisible part of the slot count.
  const overhang =
    slots?.providerUsedCost != null ? Math.max(0, slots.providerUsedCost - slots.reservedCost) : 0

  // The 2s refetch keeps the data fresh, but for a still-running job it returns deep-equal rows
  // that structural sharing collapses to the same reference — so the turnaround clock (a
  // render-time new Date()) never advances without this tick while a job is in flight.
  // Held slots need the same tick for their age readout.
  useNowTick(
    holders.length > 0 ||
      (jobs ?? []).some((j) => j.status === 'running' || j.status === 'pending'),
  )

  if (!story) return <div className="queue-view">No active story.</div>

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

  const slotsHeadline = !slots
    ? '…'
    : slots.mode === 'live'
      ? `${slots.providerUsedCost} / ${slots.max} in use at Featherless`
      : `${slots.reservedCost} / ${slots.max} (local estimate — provider feed offline)`

  return (
    <div className="queue-view">
      <h2>Queue</h2>
      <div className="queue-slots-bar">
        Concurrency: {slotsHeadline}
        <button
          type="button"
          className="danger queue-panic-button"
          onClick={handlePanic}
          disabled={panic.isPending}
        >
          {panic.isPending ? 'Stopping…' : 'Panic — stop everything'}
        </button>
        {panic.data && (
          <span className="queue-panic-result">
            Aborted {panic.data.aborted}, reaped {panic.data.reaped}
          </span>
        )}
      </div>
      {holders.length > 0 || overhang > 0 ? (
        <div className="queue-slots-holders">
          {holders.map((h) => (
            <div key={h.jobId} className="queue-slot-holder">
              <span className="queue-slot-holder-type">
                {h.jobType}
                {h.agentRole ? ` (${h.agentRole})` : ''}
              </span>
              {h.storyName && <span className="queue-slot-holder-story">{h.storyName}</span>}
              <span>cost {h.cost}</span>
              <span>{holderAge(h)}</span>
            </div>
          ))}
          {overhang > 0 && (
            <div className="queue-slot-overhang">
              +{overhang} in use at Featherless with no local job — a retried or just-aborted call
              their side still counts; frees itself when that generation ends
            </div>
          )}
        </div>
      ) : (
        slots && <div className="queue-slots-idle">No slots held.</div>
      )}
      <div className="queue-job-list">
        {(jobs ?? []).map((job) => (
          <div key={job.id} className={`queue-job queue-job-${job.status}`}>
            <div className="queue-job-line1">
              <span>{new Date(job.createdAt).toLocaleString()}</span>
              <span className="queue-job-type">{job.jobType}</span>
              <span className="queue-job-agent">{job.agentRole ?? '—'}</span>
              <span className="queue-job-status">{job.status}</span>
              <span>{jobElapsed(job)}</span>
              <span>{job.tokenEstimate != null ? `${job.tokenEstimate} tok` : '—'}</span>
            </div>
            <div className="queue-job-line2">
              <span className="queue-job-model">{job.model ?? '—'}</span>
              <span>cost {job.slotCost}</span>
              <span>pri {job.priority}</span>
              <span
                className={`queue-job-response ${job.status === 'failed' ? 'queue-job-response-error' : ''}`}
              >
                {jobResponse(job)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
