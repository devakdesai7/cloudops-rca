/**
 * useTriageSocket
 *
 * Manages a WebSocket connection to ws://<VITE_WS_BASE>/ws/incidents/:incidentId.
 * Automatically reconnects with a fixed back-off when the socket closes unexpectedly.
 * Intentionally closed on unmount — no reconnect after that.
 *
 * Returns:
 *   wsState  — "connecting" | "open" | "closed" | "error"
 *
 * Pass null as incidentId to keep the hook mounted without opening any socket
 * (used when the parent wants to conditionally disable the connection).
 */

import { useCallback, useEffect, useRef, useState } from 'react'

const WS_BASE = (import.meta.env.VITE_WS_BASE ?? 'ws://localhost:4000').replace(/\/$/, '')

const RECONNECT_DELAY_MS = 3000
const MAX_RECONNECT_ATTEMPTS = 8

/**
 * @param {string|null} incidentId
 * @param {(msg: object) => void} onMessage  — stable ref, called for every parsed JSON message
 */
export function useTriageSocket(incidentId, onMessage) {
  const [wsState, setWsState] = useState(() => (incidentId ? 'connecting' : 'closed'))

  // Keep a ref to the latest onMessage handler so the socket callbacks always
  // call the current version without needing to re-register.
  const onMessageRef = useRef(onMessage)
  useEffect(() => {
    onMessageRef.current = onMessage
  })

  // Ref to the active WebSocket so cleanup can close it imperatively.
  const socketRef = useRef(null)
  // Flag set on intentional unmount so we suppress the reconnect.
  const unmountedRef = useRef(false)
  const attemptRef = useRef(0)

  // Store connect in a ref so the ws.onclose callback can schedule a retry
  // without capturing a stale closure (avoids the self-reference lint warning).
  const connectRef = useRef(null)

  const connect = useCallback(() => {
    if (unmountedRef.current || !incidentId) return

    const url = `${WS_BASE}/ws/incidents/${incidentId}`
    const ws = new WebSocket(url)
    socketRef.current = ws
    setWsState('connecting')

    ws.onopen = () => {
      attemptRef.current = 0
      setWsState('open')
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        onMessageRef.current(msg)
      } catch {
        // Ignore unparseable frames
      }
    }

    ws.onerror = () => {
      setWsState('error')
    }

    ws.onclose = (event) => {
      if (unmountedRef.current) return
      // code 1000 = normal closure (e.g. server signalled incident resolved)
      if (event.code === 1000) {
        setWsState('closed')
        return
      }
      setWsState('error')
      if (attemptRef.current < MAX_RECONNECT_ATTEMPTS) {
        attemptRef.current += 1
        // Use the ref to avoid a self-referential closure
        setTimeout(() => connectRef.current?.(), RECONNECT_DELAY_MS)
      } else {
        setWsState('closed')
      }
    }
  }, [incidentId])

  // Keep the ref in sync with the latest connect function
  useEffect(() => {
    connectRef.current = connect
  })

  useEffect(() => {
    if (!incidentId) return

    unmountedRef.current = false
    attemptRef.current = 0
    connect()

    return () => {
      unmountedRef.current = true
      if (socketRef.current) {
        socketRef.current.onclose = null // prevent the reconnect path
        socketRef.current.close()
      }
    }
  }, [connect, incidentId])

  return wsState
}
