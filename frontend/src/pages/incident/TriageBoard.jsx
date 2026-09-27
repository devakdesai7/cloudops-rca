/**
 * TriageBoard
 *
 * Renders live service investigation cards for one incident.
 *
 * Props:
 *   incidentId            {string}    — used to build the WebSocket URL
 *   initialServices       {Array<{ service, status, verdict }>}
 *                                    — seed state from GET /api/incidents/:id
 *   onHypothesis          {Function}  — called with hypothesis object (hypothesis_ready)
 *   onAwaitingApproval    {Function}  — called with proposedFix object when awaiting_approval
 *   onFixApplied          {Function}  — called with result string (fix_applied)
 *   onIncidentResolved    {Function}  — called with timeToResolutionMs (incident_resolved)
 *   useMock               {boolean}   — when true, skips the real WS and replays
 *                                       synthetic events on a timer so the animations
 *                                       can be verified without a running backend.
 *                                       ⚠️  Remove / set to false before shipping.
 *
 * WebSocket message types handled (per shared-contract.md):
 *   subagent_update     → updates the service map
 *   hypothesis_ready    → forwarded via onHypothesis
 *   awaiting_approval   → forwarded via onAwaitingApproval
 *   fix_applied         → forwarded via onFixApplied
 *   incident_resolved   → forwarded via onIncidentResolved
 */

import { useCallback, useEffect, useReducer } from 'react'
import { useTriageSocket } from './useTriageSocket'
import styles from './TriageBoard.module.css'

// ---------------------------------------------------------------------------
// State: Map<serviceName, { status, verdict }>
// ---------------------------------------------------------------------------

function servicesReducer(state, action) {
  switch (action.type) {
    case 'INIT': {
      // Seed from the REST snapshot — preserve any live updates that
      // arrived before the REST call returned (unlikely but safe).
      const next = { ...state }
      for (const svc of action.services) {
        if (!next[svc.service]) {
          next[svc.service] = { status: svc.status, verdict: svc.verdict ?? null }
        }
      }
      return next
    }
    case 'UPDATE': {
      return {
        ...state,
        [action.service]: {
          status: action.status,
          verdict: action.verdict ?? state[action.service]?.verdict ?? null,
        },
      }
    }
    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Dev mock — emits fake subagent_update events on a timer so the UI
// animations can be verified without a running backend.
// NOTE: this is scaffolding only. Real integration must be tested once
// Shivang's backend + Bob pipeline are available.
// ---------------------------------------------------------------------------

const MOCK_SERVICES = ['api-gateway', 'order-service', 'payment-service', 'inventory-service']

const MOCK_VERDICTS = {
  'api-gateway':       'healthy — no anomalies in logs or deploys',
  'order-service':     'healthy — all requests within normal latency bounds',
  'payment-service':   'confirmed_anomaly — DOWNSTREAM_TIMEOUT_MS reduced to 50 ms at 13:58 UTC deploy',
  'inventory-service': 'healthy — no recent deploys, logs clean',
}

const MOCK_HYPOTHESIS = {
  rootCauseService: 'payment-service',
  explanation:
    'A deployment at 13:58 UTC set DOWNSTREAM_TIMEOUT_MS to 50 ms, far below the ' +
    'p99 upstream response time of ~340 ms. This caused the payment-service to ' +
    'time out on nearly every checkout request, propagating latency up through ' +
    'order-service to the API gateway.',
  confidence: 0.91,
  evidenceRefs: [
    '2024-01-15T13:58:02Z payment-service deploy: commit a3f9c12 — "reduce timeout for faster failures" (author: dev-bot)',
    'payment-service logs 13:58–14:02 UTC — 2,847 lines: DOWNSTREAM_TIMEOUT hit, avg latency 342 ms vs threshold 50 ms',
    'order-service logs 13:58–14:02 UTC — upstream payment calls returning 504 at rate 94%',
    'Runbook: payment-service — DOWNSTREAM_TIMEOUT_MS controls the hard cut-off for downstream HTTP calls; recommended minimum is 2000 ms for production traffic',
    'inventory-service: no recent deploys, error rate 0.02% (baseline), marked healthy',
    'api-gateway: request count normal, all elevated latency traces route through /checkout → order-service → payment-service',
  ],
}

const MOCK_PROPOSED_FIX = {
  service: 'payment-service',
  action: 'config_change',
  description: 'Restore DOWNSTREAM_TIMEOUT_MS to the recommended production value of 5000 ms.',
  diff: `--- a/payment-service/.env
+++ b/payment-service/.env
@@ -1,3 +1,3 @@
 NODE_ENV=production
-DOWNSTREAM_TIMEOUT_MS=50
+DOWNSTREAM_TIMEOUT_MS=5000
 PORT=3002`,
}

function useMockSocket(dispatch, onHypothesis, onAwaitingApproval, onFixApplied, onIncidentResolved) {
  useEffect(() => {
    // Seed initial state immediately
    dispatch({
      type: 'INIT',
      services: MOCK_SERVICES.map((s) => ({ service: s, status: 'queued', verdict: null })),
    })

    const timers = []

    MOCK_SERVICES.forEach((service, i) => {
      // All start "investigating" at staggered offsets (±200 ms) to show parallel start
      const startOffset = 800 + i * 200
      timers.push(
        setTimeout(() => {
          dispatch({ type: 'UPDATE', service, status: 'investigating', verdict: null })
        }, startOffset)
      )

      // Each service finishes at a different time (simulating real async work)
      const doneOffset = startOffset + 2500 + i * 800
      timers.push(
        setTimeout(() => {
          dispatch({
            type: 'UPDATE',
            service,
            status: 'done',
            verdict: MOCK_VERDICTS[service],
          })
        }, doneOffset)
      )
    })

    // hypothesis_ready at ~7 s
    timers.push(setTimeout(() => onHypothesis(MOCK_HYPOTHESIS), 7000))
    // awaiting_approval at ~8 s (Bob has finished reasoning, proposed a fix)
    timers.push(setTimeout(() => onAwaitingApproval(MOCK_PROPOSED_FIX), 8000))
    // fix_applied + incident_resolved fire only after the user approves —
    // IncidentDetail drives those from the API response, not the mock timer.
    // We expose them here for completeness; they're triggered in IncidentDetail
    // after the approveIncident() call resolves.

    return () => timers.forEach(clearTimeout)
  }, [dispatch, onHypothesis, onAwaitingApproval, onFixApplied, onIncidentResolved])
}

// ---------------------------------------------------------------------------
// WS connection banner
// ---------------------------------------------------------------------------

const WS_BANNER = {
  connecting:  { cls: styles.wsBannerReconnecting, text: 'Connecting…' },
  open:        { cls: styles.wsBannerOpen,         text: 'Live — connected' },
  error:       { cls: styles.wsBannerReconnecting, text: 'Reconnecting…' },
  closed:      { cls: styles.wsBannerClosed,       text: 'Disconnected' },
}

// ---------------------------------------------------------------------------
// ServiceCard
// ---------------------------------------------------------------------------

function ServiceCard({ name, status, verdict }) {
  const dotCls =
    status === 'investigating' ? styles.dotInvestigating :
    status === 'done'          ? styles.dotDone :
                                 styles.dotQueued

  const labelCls =
    status === 'investigating' ? styles.labelInvestigating :
    status === 'done'          ? styles.labelDone :
                                 styles.labelQueued

  const cardStatus =
    status === 'investigating' ? styles.investigating :
    status === 'done'          ? styles.done :
                                 styles.queued

  return (
    <div className={`${styles.card} ${cardStatus}`}>
      <p className={styles.serviceName}>{name}</p>
      <div className={styles.statusRow}>
        <span className={`${styles.dot} ${dotCls}`} />
        <span className={`${styles.statusLabel} ${labelCls}`}>{status}</span>
      </div>
      {status === 'done' && verdict && (
        <p className={styles.verdict}>{verdict}</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TriageBoard
// ---------------------------------------------------------------------------

export default function TriageBoard({
  incidentId,
  initialServices = [],
  onHypothesis = () => {},
  onAwaitingApproval = () => {},
  onFixApplied = () => {},
  onIncidentResolved = () => {},
  useMock = false,
}) {
  const [services, dispatch] = useReducer(servicesReducer, {})

  // Seed from REST snapshot once we have it
  useEffect(() => {
    if (initialServices.length > 0) {
      dispatch({ type: 'INIT', services: initialServices })
    }
  }, [initialServices])

  // Handle incoming WS messages
  const handleMessage = useCallback((msg) => {
    if (msg.type === 'subagent_update') {
      dispatch({
        type: 'UPDATE',
        service: msg.service,
        status: msg.status,
        verdict: msg.verdict ?? null,
      })
    } else if (msg.type === 'hypothesis_ready' && msg.hypothesis) {
      onHypothesis(msg.hypothesis)
    } else if (msg.type === 'awaiting_approval') {
      // The backend broadcasts awaiting_approval; proposedFix comes from the
      // REST snapshot. We call onAwaitingApproval with no argument here;
      // IncidentDetail will re-fetch or use the REST-seeded proposedFix.
      onAwaitingApproval(null)
    } else if (msg.type === 'fix_applied') {
      onFixApplied(msg.result ?? null)
    } else if (msg.type === 'incident_resolved') {
      onIncidentResolved(msg.timeToResolutionMs ?? null)
    }
  }, [onHypothesis, onAwaitingApproval, onFixApplied, onIncidentResolved])

  // Real WebSocket — always called (hooks must not be conditional).
  const wsStateReal = useTriageSocket(useMock ? null : incidentId, handleMessage)
  const wsState = useMock ? 'open' : wsStateReal

  // Dev mock — always called; noop args passed when not in mock mode
  const noop = useCallback(() => {}, [])
  useMockSocket(
    useMock ? dispatch : noop,
    useMock ? onHypothesis : noop,
    useMock ? onAwaitingApproval : noop,
    useMock ? onFixApplied : noop,
    useMock ? onIncidentResolved : noop,
  )

  const banner = WS_BANNER[wsState] ?? WS_BANNER.closed
  const entries = Object.entries(services)

  return (
    <div>
      {/* Connection status banner — hidden when open and not mocked */}
      {(wsState !== 'open' || useMock) && (
        <div className={`${styles.wsBanner} ${banner.cls}`}>
          <span className={styles.wsBannerDot} />
          {useMock ? '⚠ Mock mode — real backend not connected' : banner.text}
        </div>
      )}

      {entries.length === 0 && (
        <p style={{ color: '#6b7280', fontSize: '0.9rem' }}>
          Waiting for service investigation to start…
        </p>
      )}

      <div className={styles.board}>
        {entries.map(([name, { status, verdict }]) => (
          <ServiceCard key={name} name={name} status={status} verdict={verdict} />
        ))}
      </div>
    </div>
  )
}
