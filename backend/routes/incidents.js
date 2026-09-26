// backend/routes/incidents.js
// All routes require a valid JWT (requireAuth applied in index.js).
//
// POST /api/incidents/trigger  → create incident row, spawn Bob, return { incidentId, status }
// GET  /api/incidents          → list all incidents, newest first
// GET  /api/incidents/:id      → full detail with services, hypothesis, proposedFix, approval
const express = require('express');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const pool = require('../db/pool');
const bobProcesses = require('../lib/bobProcesses');

const router = express.Router();

// ── Bob event handlers ────────────────────────────────────────────────────────

/**
 * Upsert a row in incident_services.
 * If a row with (incident_id, service) already exists, update it;
 * otherwise insert a new one.
 */
async function handleSubagentUpdate(incidentId, event) {
  const { service, status, verdict = null } = event;
  try {
    await pool.query(
      `INSERT INTO incident_services (incident_id, service, status, verdict)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (incident_id, service)
       DO UPDATE SET status = EXCLUDED.status,
                     verdict = EXCLUDED.verdict`,
      [incidentId, service, status, verdict]
    );
  } catch (err) {
    console.error(`[bob:${incidentId}] subagent_update DB error:`, err.message);
  }
}

/**
 * Write hypothesis JSON into the incidents row.
 */
async function handleHypothesisReady(incidentId, event) {
  const { hypothesis } = event;
  try {
    await pool.query(
      `UPDATE incidents SET hypothesis_json = $1 WHERE id = $2`,
      [JSON.stringify(hypothesis), incidentId]
    );
  } catch (err) {
    console.error(`[bob:${incidentId}] hypothesis_ready DB error:`, err.message);
  }
}

/**
 * Transition the incident to "awaiting_approval".
 */
async function handleAwaitingApproval(incidentId) {
  try {
    await pool.query(
      `UPDATE incidents SET status = 'awaiting_approval' WHERE id = $1`,
      [incidentId]
    );
  } catch (err) {
    console.error(`[bob:${incidentId}] awaiting_approval DB error:`, err.message);
  }
}

/**
 * Mark the incident as investigation_failed so it never stays stuck
 * in "investigating" after the Bob process exits with an error.
 */
async function markInvestigationFailed(incidentId) {
  try {
    await pool.query(
      `UPDATE incidents SET status = 'investigation_failed' WHERE id = $1 AND status = 'investigating'`,
      [incidentId]
    );
    console.error(`[bob:${incidentId}] Bob process failed — status set to investigation_failed`);
  } catch (err) {
    console.error(`[bob:${incidentId}] Failed to mark investigation_failed:`, err.message);
  }
}

// ── Bob process spawner ───────────────────────────────────────────────────────

/**
 * Spawn Bob as a child process for the given incident.
 * Streams stdout line-by-line, parsing BOB_EVENT: prefixed lines.
 * Stores the process entry in the shared bobProcesses map.
 */
function spawnBobForIncident(incidentId, summary, affectedEndpoint) {
  const prompt =
    `You are running the triage-debug workflow for incident ${incidentId}. ` +
    `Summary: ${summary}. ` +
    `Affected endpoint: ${affectedEndpoint || 'unknown'}. ` +
    `Run the triage-debug workflow: investigate all relevant services, emit BOB_EVENT lines ` +
    `as defined in the shared contract, and conclude with an awaiting_approval event.`;

  let proc;
  try {
    proc = spawn('bob', ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Inherit the current environment so bob can find its config
      env: process.env,
    });
  } catch (spawnErr) {
    // spawn() itself threw synchronously — command not found at OS level
    console.error(`[bob:${incidentId}] Failed to spawn bob:`, spawnErr.message);
    markInvestigationFailed(incidentId);
    return;
  }

  // Register in the shared map immediately so WebSocket/approve tasks can find it
  const entry = {
    proc,
    status: 'running',
    exitCode: null,
    listeners: new Set(),
  };
  bobProcesses.set(incidentId, entry);

  console.log(`[bob:${incidentId}] Spawned Bob (pid ${proc.pid}) for incident "${summary}"`);

  // Guard: ensure markInvestigationFailed is called at most once per incident
  let failureHandled = false;
  function handleFailure() {
    if (failureHandled) return;
    failureHandled = true;
    markInvestigationFailed(incidentId);
  }

  // ── stdout: buffer + split on newlines ──────────────────────────────────────
  let lineBuffer = '';

  proc.stdout.on('data', (chunk) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split('\n');
    // Keep the last (potentially incomplete) fragment in the buffer
    lineBuffer = lines.pop();

    for (const line of lines) {
      // Notify any additional listeners registered by the WebSocket task
      for (const listener of entry.listeners) {
        try { listener(line); } catch (_) { /* ignore listener errors */ }
      }

      const BOB_EVENT_PREFIX = 'BOB_EVENT:';
      if (!line.startsWith(BOB_EVENT_PREFIX)) continue;

      const jsonStr = line.slice(BOB_EVENT_PREFIX.length).trim();
      let event;
      try {
        event = JSON.parse(jsonStr);
      } catch (parseErr) {
        console.warn(`[bob:${incidentId}] Could not parse BOB_EVENT JSON: ${jsonStr}`);
        continue;
      }

      console.log(`[bob:${incidentId}] BOB_EVENT received:`, event);

      switch (event.type) {
        case 'subagent_update':
          handleSubagentUpdate(incidentId, event);
          break;
        case 'hypothesis_ready':
          handleHypothesisReady(incidentId, event);
          break;
        case 'awaiting_approval':
          handleAwaitingApproval(incidentId);
          break;
        default:
          // Unknown event types are logged but not fatal
          console.log(`[bob:${incidentId}] Unknown BOB_EVENT type: ${event.type}`);
      }
    }
  });

  // ── stderr: log but don't fail on individual lines ──────────────────────────
  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[bob:${incidentId}] stderr: ${chunk}`);
  });

  // ── process exit ────────────────────────────────────────────────────────────
  proc.on('error', (err) => {
    // Emitted when the process could not be spawned (e.g. ENOENT) or killed
    console.error(`[bob:${incidentId}] Bob process error:`, err.message);
    entry.status = 'exited';
    entry.exitCode = null;
    handleFailure();
  });

  proc.on('close', (code) => {
    entry.status = 'exited';
    entry.exitCode = code;

    // Flush any remaining buffered content that didn't end with a newline
    if (lineBuffer.trim()) {
      const line = lineBuffer.trim();
      lineBuffer = '';
      for (const listener of entry.listeners) {
        try { listener(line); } catch (_) { /* ignore */ }
      }
      const BOB_EVENT_PREFIX = 'BOB_EVENT:';
      if (line.startsWith(BOB_EVENT_PREFIX)) {
        try {
          const event = JSON.parse(line.slice(BOB_EVENT_PREFIX.length).trim());
          if (event.type === 'subagent_update') handleSubagentUpdate(incidentId, event);
          else if (event.type === 'hypothesis_ready') handleHypothesisReady(incidentId, event);
          else if (event.type === 'awaiting_approval') handleAwaitingApproval(incidentId);
        } catch (_) { /* ignore */ }
      }
    }

    if (code !== 0) {
      console.error(`[bob:${incidentId}] Bob exited with code ${code} — marking investigation_failed`);
      handleFailure();
    } else {
      console.log(`[bob:${incidentId}] Bob exited cleanly (code 0)`);
    }
  });
}

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

    // Respond immediately — Bob runs asynchronously
    res.status(201).json({ incidentId, status: 'triage_started' });

    // Spawn Bob after responding so the HTTP round-trip is never blocked
    spawnBobForIncident(incidentId, summary, affectedEndpoint || 'unknown');
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
