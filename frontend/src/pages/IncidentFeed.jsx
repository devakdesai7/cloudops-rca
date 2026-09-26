import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listIncidents, triggerIncident } from '../api/client'
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

  // Initial fetch + interval
  useEffect(() => {
    fetchList()
    const id = setInterval(fetchList, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchList])

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
        <h2 className={styles.heading}>Start Triage</h2>

        <form onSubmit={handleTrigger} style={{ marginBottom: '2rem' }}>
          <div style={{ marginBottom: '0.75rem' }}>
            <label htmlFor="summary" style={{ display: 'block', marginBottom: '0.25rem' }}>
              Summary
            </label>
            <input
              id="summary"
              type="text"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              required
              style={{ width: '100%', padding: '0.45rem 0.6rem', boxSizing: 'border-box' }}
            />
          </div>

          <div style={{ marginBottom: '0.75rem' }}>
            <label htmlFor="affectedEndpoint" style={{ display: 'block', marginBottom: '0.25rem' }}>
              Affected Endpoint
            </label>
            <input
              id="affectedEndpoint"
              type="text"
              value={affectedEndpoint}
              onChange={(e) => setAffectedEndpoint(e.target.value)}
              required
              style={{ width: '100%', padding: '0.45rem 0.6rem', boxSizing: 'border-box' }}
            />
          </div>

          {triggerError && (
            <p style={{ color: 'red', margin: '0 0 0.5rem' }}>{triggerError}</p>
          )}

          <button type="submit" disabled={triggering}>
            {triggering ? 'Starting…' : 'Start Triage'}
          </button>
        </form>

        <h2 className={styles.heading}>Past Incidents</h2>

        {listError && <p style={{ color: 'red' }}>{listError}</p>}

        {incidents.length === 0 && !listError && (
          <p className={styles.placeholder}>No incidents yet.</p>
        )}

        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {incidents.map((inc) => (
            <li
              key={inc.incidentId}
              onClick={() => navigate(`/incidents/${inc.incidentId}`)}
              style={{
                padding: '0.75rem 1rem',
                marginBottom: '0.5rem',
                background: '#ffffff',
                border: '1px solid #e5e7eb',
                borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              <div style={{ fontWeight: 600 }}>{inc.summary}</div>
              <div style={{ fontSize: '0.85rem', color: '#57606a', marginTop: '0.2rem' }}>
                <span>{inc.status}</span>
                {' · '}
                <span>{new Date(inc.createdAt).toLocaleString()}</span>
              </div>
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}
