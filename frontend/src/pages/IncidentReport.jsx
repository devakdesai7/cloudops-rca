import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getReport } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import styles from './IncidentReport.module.css'

export default function IncidentReport() {
  const { incidentId } = useParams()
  const { name, role, logout } = useAuth()
  
  const [reportMd, setReportMd] = useState(null)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    let cancelled = false
    getReport(incidentId)
      .then((data) => {
        if (!cancelled) setReportMd(data)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message)
      })
    return () => { cancelled = true }
  }, [incidentId])

  const handleDownload = () => {
    if (!reportMd) return
    const blob = new Blob([reportMd], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `incident-${incidentId.slice(0, 8)}-report.md`
    a.click()
    URL.revokeObjectURL(url)
  }

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
        <div className={styles.toolbar}>
          <Link to={`/incidents/${incidentId}`} className={styles.backLink}>
            ← Back to Incident
          </Link>
          {reportMd && (
            <button className={styles.downloadBtn} onClick={handleDownload}>
              ⬇ Download .md
            </button>
          )}
        </div>

        {loadError && (
          <p className={styles.errorMsg}>
            Failed to load incident report: {loadError}
          </p>
        )}

        {!reportMd && !loadError && (
          <p className={styles.loadingMsg}>Loading report…</p>
        )}

        {reportMd && (
          <pre className={styles.reportBody}>
            {reportMd}
          </pre>
        )}
      </main>
    </div>
  )
}
