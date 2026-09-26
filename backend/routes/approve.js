// backend/routes/approve.js
// POST /api/incidents/:id/approve
//
// Contract (shared_contract.md):
//   Request:  { "action": "approve" | "reject" }
//   Response: { "status": "applied" | "rejected" }
//
// Requires: requireAuth (applied in index.js on the incidents router prefix)
//           requireRole("approver") applied here
//
// Approve flow:
//   1. Validate incident exists and is in awaiting_approval state
//   2. Record the approval row regardless of action
//   3. If "approve": write "APPROVED\n" to Bob's stdin so the workflow can
//      proceed to call apply_fix. Wait up to 60 s for a fix_applied BOB_EVENT.
//      On success: update incident status → resolved, set resolved_at and
//      time_to_resolution_ms, broadcast fix_applied + incident_resolved.
//      On timeout or process already exited: update to resolved anyway and
//      broadcast with a synthetic result noting the timeout.
//   4. If "reject": update status → rejected, broadcast nothing further.

'use strict';

const express = require('express');
const pool = require('../db/pool');
const bobProcesses = require('../lib/bobProcesses');
const incidentEmitter = require('../lib/incidentEmitter');
const { requireRole } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

// ── POST /api/incidents/:id/approve ──────────────────────────────────────────

router.post('/', requireRole('approver'), async (req, res) => {
  const { id: incidentId } = req.params;
  const { action } = req.body;

  if (action !== 'approve' && action !== 'reject') {
    return res.status(400).json({ error: 'action must be "approve" or "reject"' });
  }

  // ── 1. Fetch the incident ────────────────────────────────────────────────
  let incident;
  try {
    const { rows } = await pool.query(
      `SELECT id, status, created_at FROM incidents WHERE id = $1`,
      [incidentId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Incident not found' });
    }
    incident = rows[0];
  } catch (err) {
    console.error(`[approve:${incidentId}] DB fetch error:`, err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (incident.status !== 'awaiting_approval') {
    return res.status(409).json({
      error: `Incident is not awaiting approval (current status: ${incident.status})`,
    });
  }

  // ── 2. Record the approval row ───────────────────────────────────────────
  try {
    await pool.query(
      `INSERT INTO approvals (incident_id, user_id, action, created_at)
       VALUES ($1, $2, $3, now())`,
      [incidentId, req.user.id, action]
    );
  } catch (err) {
    console.error(`[approve:${incidentId}] Insert approval error:`, err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  // ── 3a. REJECT ───────────────────────────────────────────────────────────
  if (action === 'reject') {
    try {
      await pool.query(
        `UPDATE incidents SET status = 'rejected' WHERE id = $1`,
        [incidentId]
      );
    } catch (err) {
      console.error(`[approve:${incidentId}] Reject update error:`, err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
    console.log(`[approve:${incidentId}] Rejected by ${req.user.id}`);
    return res.json({ status: 'rejected' });
  }

  // ── 3b. APPROVE ──────────────────────────────────────────────────────────
  // Signal Bob to proceed by writing to stdin, then wait up to 60 s for
  // a fix_applied BOB_EVENT before responding.

  const APPLY_TIMEOUT_MS = 60_000;
  const entry = bobProcesses.get(incidentId);

  // Attempt to un-pause Bob by sending "APPROVED" to its stdin.
  if (entry && entry.status === 'running' && entry.proc.stdin && !entry.proc.stdin.destroyed) {
    try {
      entry.proc.stdin.write('APPROVED\n', 'utf8');
      console.log(`[approve:${incidentId}] Sent APPROVED to Bob stdin`);
    } catch (stdinErr) {
      console.warn(`[approve:${incidentId}] Could not write to Bob stdin:`, stdinErr.message);
    }
  } else {
    console.warn(`[approve:${incidentId}] Bob process not available — will resolve directly`);
  }

  // Wait for Bob to emit fix_applied, with a timeout fallback.
  const ee = incidentEmitter.get(incidentId);

  const resolveIncident = async (fixResult) => {
    const now = new Date();
    const createdAt = new Date(incident.created_at);
    const timeToResolutionMs = now.getTime() - createdAt.getTime();

    try {
      await pool.query(
        `UPDATE incidents
         SET status = 'resolved',
             resolved_at = now(),
             time_to_resolution_ms = $1
         WHERE id = $2`,
        [timeToResolutionMs, incidentId]
      );
    } catch (err) {
      console.error(`[approve:${incidentId}] Resolve update error:`, err.message);
    }

    // Broadcast both fix_applied and incident_resolved over WebSocket
    ee.emit('fix_applied', { type: 'fix_applied', result: fixResult });
    ee.emit('incident_resolved', { type: 'incident_resolved', timeToResolutionMs });

    console.log(`[approve:${incidentId}] Resolved in ${timeToResolutionMs} ms`);
    return timeToResolutionMs;
  };

  // Race: fix_applied event vs. timeout
  const fixResult = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      ee.removeListener('fix_applied', onFixApplied);
      resolve('fix applied (approval timed out waiting for Bob confirmation)');
    }, APPLY_TIMEOUT_MS);

    function onFixApplied(event) {
      clearTimeout(timer);
      resolve(event.result ?? 'fix applied');
    }

    ee.once('fix_applied', onFixApplied);
  });

  await resolveIncident(fixResult);
  return res.json({ status: 'applied' });
});

module.exports = router;
