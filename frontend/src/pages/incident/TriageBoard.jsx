/**
 * TriageBoard
 *
 * Renders live service investigation cards for one incident.
 *
 * Props:
 *   incidentId  {string}   — used to build the WebSocket URL
 *   initialServices {Array<{ service, status, verdict }>}
 *                          — seed state from GET /api/incidents/:id
 *   useMock     {boolean}  — when true, skips the real WS and replays
 *                            synthetic events on a timer so the animations
 *                            can be verified without a running backend.
 *                            ⚠️  Remove / set to false before shipping.
 *
 * WebSocket message types handled (per shared-contract.md):
 *   subagent_update  → updates the service map
 *   hypothesis_ready → surfaced as a prop-up summary (future task)
 *   awaiting_approval, fix_applied, incident_resolved → ignored here for now
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

function useMockSocket(dispatch) {
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

    return () => timers.forEach(clearTimeout)
  }, [dispatch])
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

export default function TriageBoard({ incidentId, initialServices = [], useMock = false }) {
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
    }
    // hypothesis_ready / awaiting_approval / fix_applied / incident_resolved
    // will be handled in Tasks 4–5; ignore here to avoid noise.
  }, [])

  // Real WebSocket — always called (hooks must not be conditional).
  // When useMock=true the hook connects but we ignore its state; in practice
  // the connection will fail silently against a non-running backend, which is
  // fine because we're only checking the mock UI here.
  const wsStateReal = useTriageSocket(useMock ? null : incidentId, handleMessage)
  const wsState = useMock ? 'open' : wsStateReal

  // Dev mock — always called; noop dispatch passed when not in mock mode
  const noop = useCallback(() => {}, [])
  useMockSocket(useMock ? dispatch : noop)

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
