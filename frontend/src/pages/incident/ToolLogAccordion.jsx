import { useState } from 'react'
import styles from './ToolLogAccordion.module.css'

export default function ToolLogAccordion({ toolCalls = [] }) {
  const [isOpen, setIsOpen] = useState(false)

  if (!toolCalls || toolCalls.length === 0) {
    return null
  }

  return (
    <div className={styles.container}>
      <button 
        className={styles.headerBtn}
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <span className={styles.icon}>🛠️</span>
        <span className={styles.title}>
          Tool Execution Audit Log ({toolCalls.length})
        </span>
        <span className={styles.chevron}>{isOpen ? '▼' : '▶'}</span>
      </button>

      {isOpen && (
        <div className={styles.content}>
          <div className={styles.timeline}>
            {toolCalls.map((tc, idx) => (
              <div key={idx} className={styles.timelineItem}>
                <div className={styles.bullet} />
                <div className={styles.itemContent}>
                  <div className={styles.itemHeader}>
                    <code className={styles.toolName}>{tc.name}</code>
                    {tc.timestamp && (
                      <span className={styles.timestamp}>
                        {new Date(tc.timestamp).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                  <pre className={styles.toolArgs}>
                    {JSON.stringify(tc.args, null, 2)}
                  </pre>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
