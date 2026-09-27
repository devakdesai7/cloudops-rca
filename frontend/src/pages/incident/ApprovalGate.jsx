/**
 * ApprovalGate
 *
 * Shown when an incident reaches "awaiting_approval" status.
 * Displays the AI-proposed fix and lets an approver accept or reject it.
 *
 * Props:
 *   incidentId   {string}
 *   proposedFix  {object|null}  — { service, action, description, diff }
 *   role         {string}       — "approver"|"viewer" from AuthContext
 *   onDecision   {Function}     — called with "approve"|"reject" after the
 *                                  API call succeeds
 *
 * State machine (local):
 *   idle → submitting → decided
 * Once decided the section greys out and both buttons stay disabled.
 */

import { useState } from 'react'
import { approveIncident } from '../../api/client'
import styles from './ApprovalGate.module.css'

// ---------------------------------------------------------------------------
// Diff renderer — colours +/- lines without any external library
// ---------------------------------------------------------------------------
function DiffView({ diff }) {
  if (!diff) return null
  const lines = diff.split('\n')
  return (
    <div className={styles.diffBlock}>
      <pre className={styles.diffPre}>
        {lines.map((line, i) => {
          let cls = styles.diffLineCtx
          if (line.startsWith('+') && !line.startsWith('+++')) cls = styles.diffLineAdded
          else if (line.startsWith('-') && !line.startsWith('---')) cls = styles.diffLineRemoved
          else if (line.startsWith('@@')) cls = styles.diffLineHunk
          return <span key={i} className={cls}>{line}</span>
        })}
      </pre>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ApprovalGate
// ---------------------------------------------------------------------------
export default function ApprovalGate({ incidentId, proposedFix, role, onDecision }) {
  const [phase, setPhase] = useState('idle') // 'idle' | 'submitting' | 'decided'
  const [error, setError] = useState(null)

  const isApprover = role === 'approver'
  const isDecided  = phase === 'decided'

  async function handleAction(action) {
    setError(null)
    setPhase('submitting')
    try {
      await approveIncident(incidentId, action)
      setPhase('decided')
      onDecision(action)
    } catch (err) {
      setError(err.message)
      setPhase('idle')
    }
  }

  return (
    <section
      className={`${styles.gate}${isDecided ? ` ${styles.decided}` : ''}`}
      aria-label="Approval Gate"
    >
      <h3 className={styles.heading}>Approval Required</h3>

      {proposedFix ? (
        <>
          {/* Metadata row */}
          <div className={styles.metaGrid}>
            <span className={styles.metaKey}>Service</span>
            <span className={styles.metaVal}>{proposedFix.service}</span>
            <span className={styles.metaKey}>Action</span>
            <span className={styles.metaVal}>{proposedFix.action}</span>
          </div>

          {/* Description */}
          {proposedFix.description && (
            <p className={styles.description}>{proposedFix.description}</p>
          )}

          {/* Diff */}
          {proposedFix.diff && (
            <>
              <p className={styles.diffHeading}>Proposed change</p>
              <DiffView diff={proposedFix.diff} />
            </>
          )}
        </>
      ) : (
        <p style={{ color: '#57606a', fontSize: '0.9rem', marginBottom: '1rem' }}>
          No proposed fix details available yet.
        </p>
      )}

      {/* Action row — only rendered before a decision */}
      {!isDecided && (
        <div className={styles.actionRow}>
          {isApprover ? (
            <>
              <button
                className={styles.btnApprove}
                disabled={phase === 'submitting'}
                onClick={() => handleAction('approve')}
              >
                {phase === 'submitting' ? 'Applying…' : '✓ Approve & Apply Fix'}
              </button>
              <button
                className={styles.btnReject}
                disabled={phase === 'submitting'}
                onClick={() => handleAction('reject')}
              >
                ✕ Reject
              </button>
            </>
          ) : (
            <p className={styles.viewerNote}>
              Only an approver can act on this fix. You are logged in as <strong>viewer</strong>.
            </p>
          )}
          {error && <p className={styles.actionError}>{error}</p>}
        </div>
      )}
    </section>
  )
}
