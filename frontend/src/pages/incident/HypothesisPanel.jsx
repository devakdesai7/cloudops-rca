/**
 * HypothesisPanel
 *
 * Renders the AI-generated root cause hypothesis for an incident.
 * Shown once hypothesis data is available — either seeded from
 * GET /api/incidents/:id or arriving live via a hypothesis_ready WebSocket
 * message (the parent threads that event in via the `hypothesis` prop).
 *
 * Props:
 *   hypothesis {object|null} — shape from shared-contract.md:
 *     { rootCauseService: string,
 *       explanation: string,
 *       confidence: number,       // 0.0 – 1.0
 *       evidenceRefs: [string] }
 *
 * Design intent:
 *   Build user trust in the AI diagnosis by showing its work, not just
 *   its conclusion. Evidence items are visible one expand-click away —
 *   low friction, high transparency.
 */

import styles from './HypothesisPanel.module.css'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether a string looks like a log line (starts with an ISO-ish
 * timestamp or a bracketed prefix). Used to apply monospace formatting.
 */
function looksLikeLog(text) {
  return /^\d{4}-\d{2}-\d{2}|^\[\w/.test(text.trim())
}

/**
 * Convert a confidence number (0–1) to a human label and a CSS data-level.
 */
function confidenceLevel(c) {
  if (c >= 0.75) return 'high'
  if (c >= 0.45) return 'medium'
  return 'low'
}

// ---------------------------------------------------------------------------
// EvidenceItem — a single <details> row
// ---------------------------------------------------------------------------

function EvidenceItem({ text }) {
  // Split on the first ' — ' or ': ' to get a short summary vs full detail.
  // If no separator found, the whole string is both summary and body.
  const sepIdx = text.search(/ [—–-]{1,2} |: /)
  const hasDetail = sepIdx !== -1 && sepIdx < text.length - 2

  const summaryText = hasDetail ? text.slice(0, sepIdx) : text
  const detailText  = hasDetail ? text.slice(sepIdx).replace(/^ [—–-]{1,2} |^: /, '') : text

  const isLog = looksLikeLog(detailText)

  return (
    <li className={styles.evidenceItem}>
      <details>
        <summary className={styles.evidenceSummary}>
          <span className={styles.evidenceChevron} aria-hidden="true">▼</span>
          <span className={styles.evidenceSummaryText}>{summaryText}</span>
        </summary>
        <div className={styles.evidenceBody}>
          {isLog ? (
            <pre className={styles.evidenceBodyText}>
              {detailText.split('\n').map((line, i) => (
                <span key={i} className={styles.logLine}>{line}</span>
              ))}
            </pre>
          ) : (
            <p className={styles.evidenceBodyText}>{detailText}</p>
          )}
        </div>
      </details>
    </li>
  )
}

// ---------------------------------------------------------------------------
// HypothesisPanel
// ---------------------------------------------------------------------------

export default function HypothesisPanel({ hypothesis }) {
  if (!hypothesis) return null

  const { rootCauseService, explanation, confidence, evidenceRefs = [] } = hypothesis

  const pct   = Math.round((confidence ?? 0) * 100)
  const level = confidenceLevel(confidence ?? 0)

  return (
    <section className={styles.panel} aria-label="Root Cause Hypothesis">
      <h3 className={styles.panelHeading}>Root Cause Hypothesis</h3>

      {/* Root cause service badge */}
      <div className={styles.rootCauseRow}>
        <span className={styles.rootCauseLabel}>Root cause</span>
        <code className={styles.rootCauseService}>{rootCauseService}</code>
      </div>

      {/* Explanation */}
      {explanation && (
        <p className={styles.explanation}>{explanation}</p>
      )}

      {/* Confidence bar */}
      <div className={styles.confidenceRow}>
        <span className={styles.confidenceLabel}>Confidence</span>
        <div className={styles.confidenceTrack} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div
            className={styles.confidenceFill}
            data-level={level}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className={styles.confidencePct}>{pct}%</span>
      </div>

      {/* Evidence refs */}
      {evidenceRefs.length > 0 && (
        <>
          <p className={styles.evidenceHeading}>
            Supporting Evidence ({evidenceRefs.length} {evidenceRefs.length === 1 ? 'item' : 'items'})
          </p>
          <ul className={styles.evidenceList}>
            {evidenceRefs.map((ref, i) => (
              <EvidenceItem key={i} text={ref} index={i} />
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
