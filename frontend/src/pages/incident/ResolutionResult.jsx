/**
 * ResolutionResult
 *
 * Shown after a fix_applied + incident_resolved sequence (or after a reject).
 *
 * Props:
 *   fixResult          {string|null}  — result text from fix_applied WS event
 *   timeToResolutionMs {number|null}  — from incident_resolved WS event
 *   wasRejected        {boolean}      — true if the approver clicked Reject
 *   incidentId         {string}       — used for the rollback call
 *   proposedFix        {object|null}  — { service, action, description, diff }
 *                                       needed to construct the rollback call
 *
 * Rollback assumption (⚠ needs backend confirmation from Shivang):
 *   There is no separate /rollback endpoint in the shared contract.
 *   This component calls POST /api/incidents/:id/approve with action "approve"
 *   again is NOT the right path — instead we assume Shivang will add
 *   POST /api/incidents/:id/rollback or reuse POST /api/chaos/reset.
 *   For now the button calls POST /api/incidents/:id/rollback directly.
 *   If that endpoint doesn't exist yet, the button will show an error
 *   ("404 Not Found") without crashing the page.
 *   *** COMMIT NOTE: rollback endpoint not yet confirmed with Shivang.
 *       POST /api/incidents/:id/rollback is assumed. Update if different. ***
 */

import { useState } from 'react'
import styles from './ResolutionResult.module.css'

// ---------------------------------------------------------------------------
// Duration formatter
// ---------------------------------------------------------------------------
function formatDuration(ms) {
  if (ms == null || ms < 0) return '—'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

// ---------------------------------------------------------------------------
// ResolutionResult
// ---------------------------------------------------------------------------
export default function ResolutionResult({
  fixResult,
  timeToResolutionMs,
  wasRejected,
  incidentId,
  proposedFix,
}) {
  const [rollbackPhase, setRollbackPhase] = useState('idle') // 'idle'|'in-flight'|'done'|'error'
  const [rollbackError, setRollbackError] = useState(null)

  async function handleRollback() {
    setRollbackError(null)
    setRollbackPhase('in-flight')
    try {
      // ⚠ Assumed endpoint — see module-level comment above.
      const res = await fetch(
        `/api/incidents/${incidentId}/rollback`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('rca_token')}`,
          },
          body: JSON.stringify({
            service: proposedFix?.service,
            action: 'revert',
          }),
        }
      )
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(txt || res.statusText)
      }
      setRollbackPhase('done')
    } catch (err) {
      setRollbackError(err.message)
      setRollbackPhase('error')
    }
  }

  // ── Rejected state ─────────────────────────────────────────────────────
  if (wasRejected) {
    return (
      <section className={`${styles.result} ${styles.rejected}`} aria-label="Fix Rejected">
        <h3 className={styles.heading}>Fix Rejected</h3>
        <p className={styles.rejectedMsg}>
          The proposed fix was rejected. No changes have been applied to the infrastructure.
          You may trigger a new incident investigation if the issue persists.
        </p>
      </section>
    )
  }

  // ── Resolved state ─────────────────────────────────────────────────────
  const duration = formatDuration(timeToResolutionMs)
  const canRollback = proposedFix?.service && rollbackPhase === 'idle'

  return (
    <section className={styles.result} aria-label="Incident Resolved">
      <h3 className={styles.heading}>Incident Resolved</h3>

      {/* Fix confirmation */}
      <div className={styles.confirmRow}>
        <span className={styles.confirmIcon} aria-hidden="true">✅</span>
        <span className={styles.confirmText}>
          {fixResult ?? 'Fix applied successfully.'}
        </span>
      </div>

      {/* Time to resolution — hero number */}
      {timeToResolutionMs != null && (
        <div className={styles.durationBox}>
          <span className={styles.durationLabel}>Time to resolution</span>
          <span className={styles.durationValue}>{duration}</span>
          <span className={styles.durationMs}>({timeToResolutionMs.toLocaleString()} ms)</span>
        </div>
      )}

      {/* Rollback */}
      <div className={styles.rollbackRow}>
        <button
          className={styles.btnRollback}
          disabled={!canRollback || rollbackPhase === 'in-flight'}
          onClick={handleRollback}
        >
          {rollbackPhase === 'in-flight' ? 'Rolling back…' : '↩ Rollback Fix'}
        </button>
        <span className={styles.rollbackNote}>
          ⚠ Assumes POST /api/incidents/:id/rollback — pending Shivang confirmation
        </span>
        {rollbackPhase === 'done' && (
          <p className={styles.rollbackSuccess}>Rollback initiated successfully.</p>
        )}
        {(rollbackPhase === 'error') && rollbackError && (
          <p className={styles.rollbackError}>{rollbackError}</p>
        )}
      </div>
    </section>
  )
}
