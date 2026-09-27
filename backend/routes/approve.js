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
//   2. Record the approval row
//   3. Update incidents.status → "approved" or "rejected"
//   4. Respond immediately
//
//   The Bob process (Phase 1) is still alive, blocking inside the
//   wait_for_approval MCP tool which polls GET /internal/incidents/:id/status.
//   Once it detects "approved", it wakes up, calls apply_fix, emits fix_applied,
//   and the parseAndDispatchBobEvent pipeline in incidents.js resolves the
//   incident in the DB and broadcasts incident_resolved over WebSocket.

'use strict';

const express = require('express');
const pool = require('../db/pool');
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
      `SELECT id, status FROM incidents WHERE id = $1`,
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

  // ── 3. Update incident status ─────────────────────────────────────────────
  // "approved" → Bob's wait_for_approval tool will detect this and call apply_fix.
  // "rejected" → Bob's wait_for_approval tool will detect this and exit cleanly.
  const newStatus = action === 'approve' ? 'approved' : 'rejected';

  try {
    await pool.query(
      `UPDATE incidents SET status = $1 WHERE id = $2`,
      [newStatus, incidentId]
    );
  } catch (err) {
    console.error(`[approve:${incidentId}] Status update error:`, err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  console.log(`[approve:${incidentId}] Action "${action}" recorded — status set to "${newStatus}"`);

  // ── 4. Respond immediately ────────────────────────────────────────────────
  // Bob is still alive and will handle the rest asynchronously.
  return res.json({ status: action === 'approve' ? 'applied' : 'rejected' });
});

module.exports = router;
