import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getIncident } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import ApprovalGate from './incident/ApprovalGate'
import HypothesisPanel from './incident/HypothesisPanel'
import ResolutionResult from './incident/ResolutionResult'
import TriageBoard from './incident/TriageBoard'
import styles from './Home.module.css'

// ---------------------------------------------------------------------------
// Real WebSocket mode — backend + Bob pipeline are live.
// ---------------------------------------------------------------------------
const USE_MOCK = false

export default function IncidentDetail() {
  const { incidentId } = useParams()
  const { name, role, logout } = useAuth()

  // ── All state declarations first, before any effects ─────────────────────
  const [incident, setIncident] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [hypothesis, setHypothesis] = useState(null)
  const [proposedFix, setProposedFix] = useState(null)
  const [showApproval, setShowApproval] = useState(false)
  const [resolution, setResolution] = useState(null)

  // ── REST snapshot ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    getIncident(incidentId)
      .then((data) => {
        if (!cancelled) {
          setIncident(data)
          if (data.hypothesis) setHypothesis(data.hypothesis)
          if (data.proposedFix) setProposedFix(data.proposedFix)
          if (data.status === 'awaiting_approval') setShowApproval(true)
          if (data.status === 'resolved') {
            setResolution({
              fixResult: null,
              timeToResolutionMs: data.timeToResolutionMs ?? null,
              wasRejected: false,
            })
          }
          if (data.status === 'rejected') {
            setResolution({ fixResult: null, timeToResolutionMs: null, wasRejected: true })
          }
        }
      })
      .catch((err) => { if (!cancelled) setLoadError(err.message) })
    return () => { cancelled = true }
  }, [incidentId])

  // ── Hypothesis callback ───────────────────────────────────────────────────
  const handleHypothesis = useCallback((h) => setHypothesis(h), [])

  const handleAwaitingApproval = useCallback((mockFix) => {
    if (mockFix) setProposedFix(mockFix)
    setShowApproval(true)
  }, [])

  const handleDecision = useCallback((action) => {
    setShowApproval(false)
    if (action === 'reject') {
      setResolution({ fixResult: null, timeToResolutionMs: null, wasRejected: true })
    }
  }, [])

  // ── Resolution callbacks (from WS events) ────────────────────────────────
  const handleFixApplied = useCallback((result) => {
    setResolution((prev) => ({
      fixResult: result,
      timeToResolutionMs: prev?.timeToResolutionMs ?? null,
      wasRejected: false,
    }))
  }, [])

  const handleIncidentResolved = useCallback((ms) => {
    setResolution((prev) => ({
      fixResult: prev?.fixResult ?? null,
      timeToResolutionMs: ms,
      wasRejected: false,
    }))
  }, [])

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.appName}>CloudOps RCA</span>
        <div className={styles.userInfo}>
          <span className={styles.userName}>{name}</span>
          <span className={styles.role}>{role}</span>
          <button className={styles.logoutBtn} onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <main className={styles.main}>
        {/* Back link */}
        <Link to="/" className={styles.backLink}>← Incident Feed</Link>

        {loadError && (
          <p className={styles.formError} style={{ marginBottom: '1rem' }}>
            Failed to load incident: {loadError}
          </p>
        )}

        {/* Incident header */}
        {incident && (
          <>
            <h2 className={styles.incidentTitle}>{incident.summary}</h2>
            <div className={styles.incidentSubtitle}>
              <span className={styles.statusPill} data-status={incident.status}>
                {incident.status.replace(/_/g, ' ')}
              </span>
              <span className={styles.dot}>·</span>
              <span>Started {new Date(incident.createdAt).toLocaleString()}</span>
              <span className={styles.dot}>·</span>
              <code>{incidentId}</code>
            </div>
          </>
        )}

        {!incident && !loadError && (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1rem' }}>
            Loading incident…
          </p>
        )}

        <p className={styles.subHeading}>Service Investigation</p>

        <TriageBoard
          incidentId={incidentId}
          initialServices={incident?.services ?? []}
          onHypothesis={handleHypothesis}
          onAwaitingApproval={handleAwaitingApproval}
          onFixApplied={handleFixApplied}
          onIncidentResolved={handleIncidentResolved}
          useMock={USE_MOCK}
        />

        {/* Hypothesis panel — animates in when available */}
        <HypothesisPanel hypothesis={hypothesis} />

        {/* Approval gate */}
        {showApproval && !resolution && (
          <ApprovalGate
            incidentId={incidentId}
            proposedFix={proposedFix ?? incident?.proposedFix ?? null}
            role={role}
            onDecision={handleDecision}
          />
        )}

        {/* Resolution / rejection result */}
        {resolution && (
          <ResolutionResult
            fixResult={resolution.fixResult}
            timeToResolutionMs={resolution.timeToResolutionMs}
            wasRejected={resolution.wasRejected}
            incidentId={incidentId}
            proposedFix={proposedFix ?? incident?.proposedFix ?? null}
          />
        )}
      </main>
    </div>
  )
}
