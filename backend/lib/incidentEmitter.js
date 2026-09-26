// lib/incidentEmitter.js
// Per-incident EventEmitter registry.
//
// When Bob emits a BOB_EVENT line, incidents.js parses it once and fires the
// matching event on that incident's emitter.  Both the DB-writing logic and
// the WebSocket broadcasting logic subscribe here — no duplicated parsing.
//
// Event names match the BOB_EVENT "type" field exactly:
//   'subagent_update'   payload: { type, service, status, verdict }
//   'hypothesis_ready'  payload: { type, hypothesis }
//   'awaiting_approval' payload: { type }
//   'fix_applied'       payload: { type, result }          (Task 6)
//   'incident_resolved' payload: { type, timeToResolutionMs } (Task 6)
//
// Usage:
//   const incidentEmitter = require('./incidentEmitter');
//   const ee = incidentEmitter.get(incidentId);   // creates if absent
//   ee.on('subagent_update', (payload) => { ... });
//   ee.emit('subagent_update', payload);           // done by incidents.js

const { EventEmitter } = require('events');

/** @type {Map<string, EventEmitter>} */
const registry = new Map();

/**
 * Return the EventEmitter for this incidentId, creating one if needed.
 * @param {string} incidentId
 * @returns {EventEmitter}
 */
function get(incidentId) {
  if (!registry.has(incidentId)) {
    const ee = new EventEmitter();
    // Raise the default listener limit slightly — each incident may have
    // several WS clients plus the DB subscriber.  11 is plenty.
    ee.setMaxListeners(20);
    registry.set(incidentId, ee);
  }
  return registry.get(incidentId);
}

/**
 * Remove the emitter once the incident is fully settled (optional cleanup).
 * Called by incidents.js when the Bob process exits.
 * @param {string} incidentId
 */
function remove(incidentId) {
  const ee = registry.get(incidentId);
  if (ee) {
    ee.removeAllListeners();
    registry.delete(incidentId);
  }
}

module.exports = { get, remove };
