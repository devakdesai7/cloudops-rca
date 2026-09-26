import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getIncident } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import TriageBoard from './incident/TriageBoard'
import styles from './Home.module.css'

// ---------------------------------------------------------------------------
// Real WebSocket mode — backend + Bob pipeline are live.
// ---------------------------------------------------------------------------
const USE_MOCK = false

export default function IncidentDetail() {
  const { incidentId } = useParams()
  const { name, role, logout } = useAuth()

  const [incident, setIncident] = useState(null)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    let cancelled = false
    getIncident(incidentId)
      .then((data) => { if (!cancelled) setIncident(data) })
      .catch((err) => { if (!cancelled) setLoadError(err.message) })
    return () => { cancelled = true }
  }, [incidentId])

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
        <Link
          to="/"
          style={{ fontSize: '0.85rem', color: '#3b82d4', textDecoration: 'none', display: 'inline-block', marginBottom: '1rem' }}
        >
          ← Back to feed
        </Link>

        {loadError && (
          <p style={{ color: 'red', marginBottom: '1rem' }}>
            Failed to load incident: {loadError}
          </p>
        )}

        {/* Incident header — shown once REST call resolves */}
        {incident && (
          <>
            <h2 className={styles.heading} style={{ marginBottom: '0.25rem' }}>
              {incident.summary}
            </h2>
            <div style={{ fontSize: '0.85rem', color: '#57606a', marginBottom: '0.4rem' }}>
              <span style={{ fontWeight: 500 }}>{incident.status}</span>
              {' · '}
              <span>Started {new Date(incident.createdAt).toLocaleString()}</span>
              {' · '}
              <code style={{ fontSize: '0.8rem', background: '#f7f8fa', padding: '0.1rem 0.3rem', borderRadius: '3px' }}>
                {incidentId}
              </code>
            </div>
          </>
        )}

        {/* While loading, show minimal header so the board can still boot */}
        {!incident && !loadError && (
          <div style={{ marginBottom: '0.75rem', color: '#9ca3af', fontSize: '0.9rem' }}>
            Loading incident…
          </div>
        )}

        <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#1f2328', margin: '1.25rem 0 0' }}>
          Service Investigation
        </h3>

        <TriageBoard
          incidentId={incidentId}
          initialServices={incident?.services ?? []}
          useMock={USE_MOCK}
        />
      </main>
    </div>
  )
}
