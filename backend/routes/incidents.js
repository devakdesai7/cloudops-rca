// backend/routes/incidents.js
// All routes require a valid JWT (requireAuth applied in index.js).
//
// POST /api/incidents/trigger  → create incident row, return { incidentId, status }
// GET  /api/incidents          → list all incidents, newest first
// GET  /api/incidents/:id      → full detail with services, hypothesis, proposedFix, approval
const express = require('express');
const { randomUUID } = require('crypto');
const pool = require('../db/pool');

const router = express.Router();

// ── POST /api/incidents/trigger ───────────────────────────────────────────────
// Request:  { summary: string, affectedEndpoint: string }
// Response: { incidentId: string, status: "triage_started" }
router.post('/trigger', async (req, res) => {
  const { summary, affectedEndpoint } = req.body;

  if (!summary) {
    return res.status(400).json({ error: 'summary is required' });
  }

  const incidentId = randomUUID();

  try {
    await pool.query(
      `INSERT INTO incidents (id, summary, affected_endpoint, status, created_at)
       VALUES ($1, $2, $3, $4, now())`,
      [incidentId, summary, affectedEndpoint || null, 'investigating']
    );

    res.status(201).json({ incidentId, status: 'triage_started' });
  } catch (err) {
    console.error('trigger error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/incidents ────────────────────────────────────────────────────────
// Response: [{ incidentId, summary, status, createdAt }]  newest first
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, summary, status, created_at
       FROM incidents
       ORDER BY created_at DESC`
    );

    const incidents = rows.map(r => ({
      incidentId: r.id,
      summary:    r.summary,
      status:     r.status,
      createdAt:  r.created_at,
    }));

    res.json(incidents);
  } catch (err) {
    console.error('list incidents error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /api/incidents/:id ────────────────────────────────────────────────────
// Full detail shape per shared_contract.md
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Main incident row
    const { rows: iRows } = await pool.query(
      `SELECT id, summary, affected_endpoint, status,
              hypothesis_json, proposed_fix_json,
              created_at, resolved_at, time_to_resolution_ms
       FROM incidents
       WHERE id = $1`,
      [id]
    );

    if (iRows.length === 0) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    const inc = iRows[0];

    // Related service rows
    const { rows: sRows } = await pool.query(
      `SELECT service, status, verdict, evidence_json
       FROM incident_services
       WHERE incident_id = $1
       ORDER BY id ASC`,
      [id]
    );

    // Most recent approval row (if any)
    const { rows: aRows } = await pool.query(
      `SELECT a.action, u.name AS approved_by, a.created_at AS approved_at
       FROM approvals a
       JOIN users u ON u.id = a.user_id
       WHERE a.incident_id = $1
       ORDER BY a.created_at DESC
       LIMIT 1`,
      [id]
    );

    const approvalRow = aRows[0];

    // Derive approval.status from incident status when no approval row exists yet
    let approvalStatus = 'pending';
    if (approvalRow) {
      approvalStatus = approvalRow.action === 'approve' ? 'approved' : 'rejected';
    }

    const detail = {
      incidentId:         inc.id,
      summary:            inc.summary,
      status:             inc.status,
      createdAt:          inc.created_at,
      resolvedAt:         inc.resolved_at ?? null,
      services: sRows.map(s => ({
        service:  s.service,
        status:   s.status,
        verdict:  s.verdict ?? null,
        evidence: s.evidence_json ?? null,
      })),
      hypothesis:  inc.hypothesis_json    ?? null,
      proposedFix: inc.proposed_fix_json  ?? null,
      approval: {
        status:     approvalStatus,
        approvedBy: approvalRow?.approved_by  ?? null,
        approvedAt: approvalRow?.approved_at  ?? null,
      },
      timeToResolutionMs: inc.time_to_resolution_ms ?? null,
    };

    res.json(detail);
  } catch (err) {
    console.error('get incident error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
