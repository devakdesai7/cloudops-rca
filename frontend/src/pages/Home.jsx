import { useAuth } from '../auth/AuthContext'
import styles from './Home.module.css'

/**
 * Placeholder — will become the Incident Feed in Task 2.
 */
export default function Home() {
  const { name, role, logout } = useAuth()

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
        <h2 className={styles.heading}>Incident Feed</h2>
        <p className={styles.placeholder}>
          Incident list will appear here — coming in Task 2.
        </p>
      </main>
    </div>
  )
}
