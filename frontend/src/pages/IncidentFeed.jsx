import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { injectChaos, listIncidents, resetChaos, triggerIncident } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import styles from './Home.module.css'

const POLL_INTERVAL_MS = 5000

export default function IncidentFeed() {
  const { name, role, logout } = useAuth()
  const navigate = useNavigate()

  // ── Trigger form ─────────────────────────────────────────────────────────
  const [summary, setSummary] = useState('')
  const [affectedEndpoint, setAffectedEndpoint] = useState('')
  const [triggerError, setTriggerError] = useState(null)
  const [triggering, setTriggering] = useState(false)

  const handleTrigger = useCallback(
    async (e) => {
      e.preventDefault()
      setTriggerError(null)
      setTriggering(true)
      try {
        const { incidentId } = await triggerIncident(summary, affectedEndpoint)
        navigate(`/incidents/${incidentId}`)
      } catch (err) {
        setTriggerError(err.message)
      } finally {
        setTriggering(false)
      }
    },
    [summary, affectedEndpoint, navigate]
  )

  // ── Incident list + polling ───────────────────────────────────────────────
  const [incidents, setIncidents] = useState([])
  const [listError, setListError] = useState(null)

  const fetchList = useCallback(async () => {
    try {
      const data = await listIncidents()
      setIncidents(data)
      setListError(null)
    } catch (err) {
      setListError(err.message)
    }
  }, [])

  useEffect(() => {
    fetchList()
    const id = setInterval(fetchList, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchList])

  // ── Chaos controls ────────────────────────────────────────────────────────
  // 'idle' | 'injecting' | 'resetting' | 'injected' | 'reset' | 'error'
  const [chaosPhase, setChaosPhase] = useState('idle')
  const [chaosMsg, setChaosMsg]     = useState(null)

  const handleInject = useCallback(async () => {
    setChaosPhase('injecting')
    setChaosMsg(null)
    try {
      await injectChaos('payment-service', 300)
      setChaosPhase('injected')
      setChaosMsg('Chaos injected — payment-service timeout set to 300 ms')
    } catch (err) {
      setChaosPhase('error')
      setChaosMsg(err.message)
    }
  }, [])

  const handleReset = useCallback(async () => {
    setChaosPhase('resetting')
    setChaosMsg(null)
    try {
      await resetChaos()
      setChaosPhase('reset')
      setChaosMsg('Infrastructure reset — payment-service restored to healthy')
    } catch (err) {
      setChaosPhase('error')
      setChaosMsg(err.message)
    }
  }, [])

  const chaosInFlight = chaosPhase === 'injecting' || chaosPhase === 'resetting'

  // ── Render ────────────────────────────────────────────────────────────────
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

        {/* ── Dev Tools (approver only) ──────────────────────────────────── */}
        {role === 'approver' && (
          <div className={styles.devTools}>
            <div className={styles.devToolsHeader}>
              <span className={styles.devToolsBadge}>Dev Tools</span>
              <span className={styles.devToolsTitle}>Chaos Controls</span>
            </div>
            <div className={styles.devToolsBody}>
              <button
                className={styles.btnChaos}
                disabled={chaosInFlight}
                onClick={handleInject}
              >
                {chaosPhase === 'injecting' ? 'Injecting…' : '⚡ Simulate payment-service slowdown'}
              </button>
              <button
                className={styles.btnReset}
                disabled={chaosInFlight}
                onClick={handleReset}
              >
                {chaosPhase === 'resetting' ? 'Resetting…' : '↺ Reset to healthy'}
              </button>
              {chaosMsg && (
                <span className={
                  chaosPhase === 'error' ? styles.chaosError : styles.chaosSuccess
                }>
                  {chaosMsg}
                </span>
              )}
              {chaosInFlight && (
                <span className={styles.chaosStatus}>
                  Waiting for container to restart…
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── Trigger form ──────────────────────────────────────────────── */}
        <p className={styles.sectionLabel}>New Incident</p>
        <div className={styles.triggerForm}>
          <form onSubmit={handleTrigger}>
            <div className={styles.formRow}>
              <div className={styles.formField}>
                <label htmlFor="summary" className={styles.formLabel}>Summary</label>
                <input
                  id="summary"
                  type="text"
                  className={styles.formInput}
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="e.g. checkout latency spike"
                  required
                />
              </div>
              <div className={styles.formField}>
                <label htmlFor="affectedEndpoint" className={styles.formLabel}>Affected Endpoint</label>
                <input
                  id="affectedEndpoint"
                  type="text"
                  className={styles.formInput}
                  value={affectedEndpoint}
                  onChange={(e) => setAffectedEndpoint(e.target.value)}
                  placeholder="e.g. /checkout"
                  required
                />
              </div>
            </div>
            <div className={styles.formActions}>
              <button type="submit" className={styles.btnPrimary} disabled={triggering}>
                {triggering ? 'Starting triage…' : 'Start Triage →'}
              </button>
              {triggerError && <p className={styles.formError}>{triggerError}</p>}
            </div>
          </form>
        </div>

        {/* ── Past incidents ──────────────────────────────────────────────── */}
        <p className={styles.sectionLabel}>Past Incidents</p>

        {listError && <p className={styles.formError}>{listError}</p>}

        {incidents.length === 0 && !listError && (
          <p className={styles.placeholder}>No incidents yet.</p>
        )}

        <ul className={styles.incidentList}>
          {incidents.map((inc) => (
            <li
              key={inc.incidentId}
              className={styles.incidentItem}
              onClick={() => navigate(`/incidents/${inc.incidentId}`)}
            >
              <span className={styles.incidentSummary}>{inc.summary}</span>
              <span className={styles.incidentMeta}>
                <span className={styles.statusPill} data-status={inc.status}>
                  {inc.status.replace(/_/g, ' ')}
                </span>
                {new Date(inc.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>

      </main>
    </div>
  )
}
