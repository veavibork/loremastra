import { useEffect, useState } from 'react'
import {
  claimSession,
  fetchUsers,
  getStoredUserId,
  type SupersededInfo,
  type SupersededReason,
  type UserProfile,
} from '../api'
import { formatRelativeTime } from '../lib/format-time'
import './ClaimGate.css'

export type GateReason = 'no-session' | SupersededReason

interface ClaimGateProps {
  reason: GateReason
  info: SupersededInfo | null
  onClaimed: () => void
}

export default function ClaimGate({ reason, info, onClaimed }: ClaimGateProps) {
  const [error, setError] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)
  const [users, setUsers] = useState<UserProfile[] | null>(null)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const [password, setPassword] = useState('')

  const superseded = reason === 'superseded'
  // Same person's other tab/device took over — reclaim just needs that user's password again, not a fresh pick.
  const reclaimUserId = superseded ? getStoredUserId() : null

  useEffect(() => {
    if (reclaimUserId) {
      setSelectedUserId(reclaimUserId)
    }
    // Fetch users in both flows — the reclaim flow still needs it to resolve reclaimUser's
    // displayName for the "Log back in as <name>" message.
    fetchUsers()
      .then(setUsers)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [reclaimUserId])

  async function handleClaim(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedUserId) return
    setClaiming(true)
    setError(null)
    try {
      await claimSession(selectedUserId, password)
      onClaimed()
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : String(err))
      setClaiming(false)
    }
  }

  const reclaimUser = reclaimUserId ? users?.find((u) => u.id === reclaimUserId) : null

  return (
    <div className="claim-gate">
      <div className="claim-gate-card">
        <h1>Loremaster</h1>
        {superseded ? (
          <>
            <p className="claim-gate-message">
              This session was superseded — another session took over the platform.
            </p>
            <div className="claim-gate-timestamps">
              {info?.stale && (
                <div>
                  Last interaction on your session: {formatRelativeTime(info.stale.lastSeenAt)}
                </div>
              )}
              {info?.active && (
                <div>
                  Last interaction on the active session:{' '}
                  {formatRelativeTime(info.active.lastSeenAt)}
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="claim-gate-message">
            This platform hasn't been claimed by this browser yet.
          </p>
        )}
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={handleClaim}>
          {!reclaimUserId && (
            <div className="claim-gate-users">
              {users === null && !error && (
                <div className="claim-gate-message">Loading profiles…</div>
              )}
              {users?.map((user) => (
                <button
                  type="button"
                  key={user.id}
                  className={`claim-gate-user${selectedUserId === user.id ? ' selected' : ''}`}
                  onClick={() => setSelectedUserId(user.id)}
                >
                  {user.displayName}
                </button>
              ))}
            </div>
          )}
          {reclaimUserId && (
            <p className="claim-gate-message">
              Log back in as {reclaimUser?.displayName ?? 'yourself'}
            </p>
          )}
          {selectedUserId && (
            <input
              type="password"
              className="claim-gate-password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          )}
          <button type="submit" disabled={claiming || !selectedUserId}>
            {claiming ? 'Claiming…' : superseded ? 'Take over' : 'Claim'}
          </button>
        </form>
      </div>
    </div>
  )
}
