// lib/wsServer.js
// WebSocket server for live incident event streaming.
//
// Contract (from docs/shared_contract.md):
//   ws://localhost:4000/ws/incidents/:incidentId
//
// Server → client JSON messages (exact contract shapes):
//   { "type": "subagent_update", "service": string, "status": "queued"|"investigating"|"done", "verdict": string|null }
//   { "type": "hypothesis_ready", "hypothesis": { rootCauseService, explanation, confidence, evidenceRefs } }
//   { "type": "awaiting_approval" }
//   { "type": "fix_applied", "result": string }
//   { "type": "incident_resolved", "timeToResolutionMs": number }
//
// All five message types are forwarded as-is from the per-incident emitter.
// The WS server handles the HTTP upgrade itself so Express never sees it.

'use strict';

const { WebSocketServer } = require('ws');
const incidentEmitter = require('./incidentEmitter');

// Regex matching /ws/incidents/<uuid-or-any-non-empty-string>
const WS_PATH_RE = /^\/ws\/incidents\/([^/?#]+)/;

/**
 * Build the correct contract-shaped payload to send to WS clients.
 * The event objects emitted by incidentEmitter already have the right shape
 * (they come straight from JSON.parse of the BOB_EVENT line), so we just
 * serialise them. This function exists as an explicit checkpoint so it's easy
 * to audit against the contract.
 */
function toWireMessage(event) {
  switch (event.type) {
    case 'subagent_update':
      return {
        type:    'subagent_update',
        service: event.service,
        status:  event.status,
        verdict: event.verdict ?? null,
      };
    case 'hypothesis_ready':
      return {
        type:       'hypothesis_ready',
        hypothesis: event.hypothesis,
      };
    case 'awaiting_approval':
      return { type: 'awaiting_approval' };
    case 'fix_applied':
      return { type: 'fix_applied', result: event.result };
    case 'incident_resolved':
      return { type: 'incident_resolved', timeToResolutionMs: event.timeToResolutionMs };
    default:
      // Forward unknown future event types unchanged so clients aren't blind to them
      return event;
  }
}

/**
 * Attach the WebSocket server to an existing http.Server instance.
 * Must be called after app.listen() so the server object exists.
 *
 * @param {import('http').Server} httpServer
 */
function attachWsServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  // ── Upgrade: only handle /ws/incidents/:id paths ──────────────────────────
  httpServer.on('upgrade', (request, socket, head) => {
    // Use WHATWG URL — url.parse() is deprecated
    const { pathname } = new URL(request.url, 'http://localhost');
    const match = WS_PATH_RE.exec(pathname);

    if (!match) {
      // Not our path — destroy the socket to avoid leaking it
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      const incidentId = match[1];
      wss.emit('connection', ws, request, incidentId);
    });
  });

  // ── Connection handler ────────────────────────────────────────────────────
  wss.on('connection', (ws, _request, incidentId) => {
    console.log(`[ws] Client connected for incident ${incidentId}`);

    // Send a welcome/ack so the client knows the connection is live
    safeSend(ws, { type: 'connected', incidentId });

    // Subscribe to all future events for this incident
    const ee = incidentEmitter.get(incidentId);

    function broadcast(event) {
      safeSend(ws, toWireMessage(event));
    }

    // Subscribe to every event type defined in the contract
    const EVENT_TYPES = [
      'subagent_update',
      'hypothesis_ready',
      'awaiting_approval',
      'fix_applied',
      'incident_resolved',
    ];
    for (const t of EVENT_TYPES) {
      ee.on(t, broadcast);
    }

    // ── Cleanup on disconnect ───────────────────────────────────────────────
    ws.on('close', () => {
      console.log(`[ws] Client disconnected from incident ${incidentId}`);
      // Remove this client's listener from every event type
      for (const t of EVENT_TYPES) {
        ee.removeListener(t, broadcast);
      }
    });

    ws.on('error', (err) => {
      console.error(`[ws] Socket error for incident ${incidentId}:`, err.message);
      // 'close' will fire after 'error' — cleanup happens there
    });
  });

  return wss;
}

/**
 * Send JSON to a WebSocket client, ignoring errors if the socket has already
 * closed (READY_STATE check + try/catch).
 */
function safeSend(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.error('[ws] safeSend error:', err.message);
  }
}

module.exports = { attachWsServer };
