// backend/routes/incidents.js
// All routes require a valid JWT (requireAuth applied in index.js).
//
// POST /api/incidents/trigger  → create incident row, spawn Bob, return { incidentId, status }
// GET  /api/incidents          → list all incidents, newest first
// GET  /api/incidents/:id      → full detail with services, hypothesis, proposedFix, approval
const express = require('express');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { readFileSync } = require('fs');
const { resolve } = require('path');
const pool = require('../db/pool');
const bobProcesses = require('../lib/bobProcesses');

// Path to the triage prompt template (relative to this file → up two dirs → mcp-server)
const PROMPT_TEMPLATE_PATH = resolve(
  __dirname, '../../mcp-server/prompts/triage-debug.md'
);

// ── Resolve bobshell's JS entry point at startup ──────────────────────────────
// We spawn `node <bob.js>` directly instead of the `bob` / `bob.cmd` wrapper.
// This bypasses cmd.exe on Windows entirely — the prompt string goes straight
// into process.argv as raw bytes, so ", <, >, |, & etc. are never interpreted
// as shell metacharacters. The same spawn call works unchanged on Linux/Docker.
//
// Resolution order: env var override → Windows global npm → Linux/Mac global npm
// If none resolve, the server logs a clear error at startup instead of failing
// silently per-incident.
let BOB_SCRIPT;
try {
  BOB_SCRIPT = process.env.BOB_SCRIPT_PATH
    // Allow explicit override (useful in Docker: set BOB_SCRIPT_PATH in the image)
    ? resolve(process.env.BOB_SCRIPT_PATH)
    // Resolve through Node's module system, searching standard global install paths
    : require.resolve('bobshell', {
        paths: [
          // Windows: %APPDATA%\npm\node_modules  (where npm i -g installs)
          resolve(process.env.APPDATA || '', 'npm', 'node_modules'),
          // Linux / Docker: standard global npm prefix locations
          '/usr/local/lib/node_modules',
          '/usr/lib/node_modules',
        ],
      });
  console.log(`Bob script resolved: ${BOB_SCRIPT}`);
} catch (resolveErr) {
  console.error(
    'ERROR: Could not resolve bobshell/dist/bob.js. ' +
    'Install bob globally (npm i -g bobshell-*.tgz) or set BOB_SCRIPT_PATH. ' +
    `Detail: ${resolveErr.message}`
  );
  // BOB_SCRIPT stays undefined; spawnBobForIncident will catch it per-incident.
}

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
  // ── Guard: bob.js must have been resolved at startup ─────────────────────
  if (!BOB_SCRIPT) {
    console.error(`[bob:${incidentId}] Cannot spawn Bob — bobshell script not resolved. Check startup logs.`);
    markInvestigationFailed(incidentId);
    return;
  }

  // ── Load and substitute the prompt template ───────────────────────────────
  let prompt;
  try {
    const template = readFileSync(PROMPT_TEMPLATE_PATH, 'utf8');
    // No newline collapsing needed — we never pass the prompt through a shell,
    // so \n, ", <, >, | etc. are all inert. Keeping original newlines gives
    // the LLM cleaner markdown structure to reason over.
    prompt = template
      .replace('{{INCIDENT_SUMMARY}}', summary)
      .replace('{{INCIDENT_ENDPOINT}}', affectedEndpoint || 'unknown');
  } catch (readErr) {
    console.error(`[bob:${incidentId}] Failed to read prompt template:`, readErr.message);
    markInvestigationFailed(incidentId);
    return;
  }

  // ── Spawn Bob directly via node — no shell, no cmd.exe ───────────────────
  // We call `node <bobshell/dist/bob.js>` instead of the `bob` / `bob.cmd`
  // wrapper. node is a real .exe on Windows — spawn('node', [...]) needs no
  // shell, so the prompt string lands in process.argv as raw bytes regardless
  // of what characters it contains. Identical on Linux/Docker.
  //
  // The prompt is passed as the final positional argument: `bob run [options] [prompt...]`
  // --max-turns / --max-cost guard against runaway cost on every run.
  // --format stream-json is intentionally omitted — it changes stdout to NDJSON,
  // which would break the BOB_EVENT: line parser below.
  const bobArgs = [
    BOB_SCRIPT,
    'run',
    '--format', 'stream-json',
    '--trust',
    '--accept-license',
    '--max-turns', '40',
    '--max-cost', '3.00',
  ];

  console.log(`[bob:${incidentId}] Prompt length: ${prompt.length} chars`);

  let proc;
  try {
    proc = spawn('node', bobArgs, {
      cwd: resolve(__dirname, '../../'), // Run from cloudops-rca root!
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    proc.stdin.write(prompt, 'utf8');
    proc.stdin.end();
  } catch (spawnErr) {
    // spawn() itself threw synchronously — node not found (should never happen)
    console.error(`[bob:${incidentId}] Failed to spawn node:`, spawnErr.message);
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

  // ── stdout: parse NDJSON stream & extract BOB_EVENTs ───────────────────────
  let streamBuffer = '';
  let llmTextBuffer = '';

  proc.stdout.on('data', (chunk) => {
    streamBuffer += chunk.toString();
    const lines = streamBuffer.split('\n');
    // Keep the last (potentially incomplete) fragment in the buffer
    streamBuffer = lines.pop();

    for (const line of lines) {
      // Notify WebSocket listeners with the raw stream chunk
      for (const listener of entry.listeners) {
        try { listener(line); } catch (_) { /* ignore listener errors */ }
      }

      if (!line.trim()) continue;

      let obj;
      try {
        obj = JSON.parse(line);
      } catch (err) {
        continue; // Not a valid NDJSON chunk
      }

      // CRITICAL: Ignore echoed prompt!
      // This prevents the "phantom event" bug where the backend parses the instructions.
      if (obj.type === 'message' && obj.role === 'user') continue;

      // Accumulate real generated text from assistant chunks or subagent tool results
      let newText = '';
      if (obj.type === 'message' && obj.role === 'assistant' && obj.content) {
        newText = obj.content;
      } else if (obj.type === 'tool_result' && obj.output) {
        newText = obj.output;
      }

      if (newText) {
        llmTextBuffer += newText;
        // Check for complete lines in the accumulated LLM text
        const textLines = llmTextBuffer.split('\n');
        llmTextBuffer = textLines.pop();

        for (const textLine of textLines) {
          parseAndDispatchBobEvent(incidentId, textLine);
        }
      }
    }
  });

  // ── stderr: log but don't fail on individual lines ──────────────────────────
  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[bob:${incidentId}] stderr: ${chunk}`);
  });

  // ── process exit ────────────────────────────────────────────────────────────
  proc.on('error', (err) => {
    console.error(`[bob:${incidentId}] Bob process error:`, err.message);
    entry.status = 'exited';
    entry.exitCode = null;
    handleFailure();
  });

  proc.on('close', (code) => {
    entry.status = 'exited';
    entry.exitCode = code;

    // Flush any remaining text in the LLM buffer
    if (llmTextBuffer.trim()) {
      parseAndDispatchBobEvent(incidentId, llmTextBuffer);
    }

    if (code !== 0) {
      console.error(`[bob:${incidentId}] Bob exited with code ${code} — marking investigation_failed`);
      handleFailure();
    } else {
      console.log(`[bob:${incidentId}] Bob exited cleanly (code 0)`);
    }
  });
}

// Helper to robustly extract and parse BOB_EVENT payloads (even with missing quotes)
function parseAndDispatchBobEvent(incidentId, textLine) {
  const match = textLine.match(/BOB_EVENT:\s*(\{.*?\})/);
  if (!match) return;

  const payloadStr = match[1].trim();
  let event = {};

  try {
    // 1. Try strict standard JSON first
    event = JSON.parse(payloadStr);
  } catch (err) {
    // 2. Fallback: Robust regex parser for unquoted JSON caused by CLI stripping
    const typeMatch = payloadStr.match(/["']?type["']?\s*:\s*["']?([^,"'}]+)["']?/);
    if (typeMatch) event.type = typeMatch[1].trim();

    if (event.type === 'subagent_update') {
      const serviceMatch = payloadStr.match(/["']?service["']?\s*:\s*["']?([^,"'}]+)["']?/);
      if (serviceMatch) event.service = serviceMatch[1].trim();

      const statusMatch = payloadStr.match(/["']?status["']?\s*:\s*["']?([^,"'}]+)["']?/);
      if (statusMatch) event.status = statusMatch[1].trim();

      const verdictMatch = payloadStr.match(/["']?verdict["']?\s*:\s*["']?(.*?)["']?(?=\}|$)/);
      if (verdictMatch) {
        const v = verdictMatch[1].trim();
        event.verdict = (v === 'null') ? null : v;
      }
    } else if (event.type === 'hypothesis_ready') {
      event.hypothesis = {};
      const rcMatch = payloadStr.match(/["']?rootCauseService["']?\s*:\s*["']?([^,"'}]+)["']?/);
      if (rcMatch) {
        const rc = rcMatch[1].trim();
        event.hypothesis.rootCauseService = (rc === 'null') ? null : rc;
      }

      const expMatch = payloadStr.match(/["']?explanation["']?\s*:\s*["']?(.*?)["']?\s*,\s*["']?confidence["']?/);
      if (expMatch) event.hypothesis.explanation = expMatch[1].trim();

      const confMatch = payloadStr.match(/["']?confidence["']?\s*:\s*([\d.]+)/);
      if (confMatch) event.hypothesis.confidence = parseFloat(confMatch[1]);
      
      event.hypothesis.evidenceRefs = [];
    }
  }

  if (!event.type) {
    console.warn(`[bob:${incidentId}] Could not parse BOB_EVENT payload: ${payloadStr}`);
    return;
  }

  console.log(`[bob:${incidentId}] BOB_EVENT received (parsed):`, event);

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
      console.log(`[bob:${incidentId}] Unknown BOB_EVENT type: ${event.type}`);
  }
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
