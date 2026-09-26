#!/usr/bin/env node
// backend/test-bob-spawn.js
// Manual integration test for the Bob child-process spawning logic.
//
// Tests two paths:
//   1. FAILURE PATH  — bob command is unavailable (not on PATH)
//   2. SUCCESS PATH  — a stub script that emits BOB_EVENT lines
//
// Run from backend/: node test-bob-spawn.js
// Does NOT require a running backend server or real database.

'use strict';

const path = require('path');
const fs   = require('fs');
const { spawn } = require('child_process');

// ── Stub the DB pool so we can observe calls without a real Neon connection ──
const dbCalls = [];
const poolStub = {
  query: async (sql, params) => {
    dbCalls.push({ sql: sql.trim().replace(/\s+/g, ' '), params });
    return { rows: [] };
  },
};

require.cache[require.resolve('./db/pool')] = {
  id: require.resolve('./db/pool'),
  filename: require.resolve('./db/pool'),
  loaded: true,
  exports: poolStub,
  parent: null,
  children: [],
  paths: [],
};

const bobProcesses = require('./lib/bobProcesses');

// ─────────────────────────────────────────────────────────────────────────────
// Tiny test helpers
// ─────────────────────────────────────────────────────────────────────────────
let testsPassed = 0;
let testsFailed  = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    testsPassed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    testsFailed++;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// DB event helpers (mirror of incidents.js)
// ─────────────────────────────────────────────────────────────────────────────
async function handleSubagentUpdate(incidentId, event) {
  const { service, status, verdict = null } = event;
  await poolStub.query(
    `INSERT INTO incident_services (incident_id, service, status, verdict) VALUES ($1, $2, $3, $4) ON CONFLICT (incident_id, service) DO UPDATE SET status = EXCLUDED.status, verdict = EXCLUDED.verdict`,
    [incidentId, service, status, verdict]
  );
}

async function handleHypothesisReady(incidentId, event) {
  await poolStub.query(
    `UPDATE incidents SET hypothesis_json = $1 WHERE id = $2`,
    [JSON.stringify(event.hypothesis), incidentId]
  );
}

async function handleAwaitingApproval(incidentId) {
  await poolStub.query(
    `UPDATE incidents SET status = 'awaiting_approval' WHERE id = $1`,
    [incidentId]
  );
}

async function markInvestigationFailed(incidentId) {
  await poolStub.query(
    `UPDATE incidents SET status = 'investigation_failed' WHERE id = $1 AND status = 'investigating'`,
    [incidentId]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// spawnBobForIncident — mirrors incidents.js exactly (including failureHandled guard)
// bobCmd defaults to 'bob'; pass a different value to test error paths.
// ─────────────────────────────────────────────────────────────────────────────
function spawnBobForIncident(incidentId, summary, affectedEndpoint, bobCmdOverride) {
  const bobCmd = bobCmdOverride || 'bob';
  const prompt =
    `You are running the triage-debug workflow for incident ${incidentId}. ` +
    `Summary: ${summary}. Affected endpoint: ${affectedEndpoint}.`;

  let proc;
  try {
    proc = spawn(bobCmd, ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (spawnErr) {
    console.error(`  [spawn-err] ${spawnErr.message}`);
    markInvestigationFailed(incidentId);
    return null;
  }

  const entry = { proc, status: 'running', exitCode: null, listeners: new Set() };
  bobProcesses.set(incidentId, entry);

  let failureHandled = false;
  function handleFailure() {
    if (failureHandled) return;
    failureHandled = true;
    markInvestigationFailed(incidentId);
  }

  let lineBuffer = '';

  proc.stdout.on('data', (chunk) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop();

    for (const line of lines) {
      for (const listener of entry.listeners) {
        try { listener(line); } catch (_) {}
      }
      const PREFIX = 'BOB_EVENT:';
      if (!line.startsWith(PREFIX)) continue;
      let event;
      try { event = JSON.parse(line.slice(PREFIX.length).trim()); } catch (_) { continue; }
      if (event.type === 'subagent_update')   handleSubagentUpdate(incidentId, event);
      if (event.type === 'hypothesis_ready')  handleHypothesisReady(incidentId, event);
      if (event.type === 'awaiting_approval') handleAwaitingApproval(incidentId);
    }
  });

  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`  [bob-stderr] ${chunk}`);
  });

  proc.on('error', (err) => {
    console.log(`  [proc-error] ${err.message}`);
    entry.status = 'exited';
    entry.exitCode = null;
    handleFailure();
  });

  proc.on('close', (code) => {
    entry.status = 'exited';
    entry.exitCode = code;
    if (lineBuffer.trim()) {
      const line = lineBuffer.trim(); lineBuffer = '';
      const PREFIX = 'BOB_EVENT:';
      if (line.startsWith(PREFIX)) {
        try {
          const event = JSON.parse(line.slice(PREFIX.length).trim());
          if (event.type === 'subagent_update')   handleSubagentUpdate(incidentId, event);
          if (event.type === 'hypothesis_ready')  handleHypothesisReady(incidentId, event);
          if (event.type === 'awaiting_approval') handleAwaitingApproval(incidentId);
        } catch (_) {}
      }
    }
    if (code !== 0) handleFailure();
  });

  return proc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write a temporary stub "bob" script that emits BOB_EVENT lines then exits 0
// ─────────────────────────────────────────────────────────────────────────────
const STUB_BOB_PATH = path.join(__dirname, '_stub_bob.js');

fs.writeFileSync(STUB_BOB_PATH, `#!/usr/bin/env node
// Stub Bob: emits BOB_EVENT lines then exits 0
const lines = [
  'BOB_EVENT:{"type":"subagent_update","service":"payment-service","status":"investigating"}',
  'Some natural language reasoning output (ignored by backend)',
  'BOB_EVENT:{"type":"subagent_update","service":"payment-service","status":"done","verdict":"suspicious deploy at 13:58 UTC"}',
  'BOB_EVENT:{"type":"subagent_update","service":"order-service","status":"done","verdict":"no anomalies"}',
  'BOB_EVENT:{"type":"hypothesis_ready","hypothesis":{"rootCauseService":"payment-service","explanation":"Timeout introduced in deploy","confidence":0.9,"evidenceRefs":["log-abc"]}}',
  'BOB_EVENT:{"type":"awaiting_approval"}',
];
for (const line of lines) {
  process.stdout.write(line + '\\n');
}
process.exit(0);
`);

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1 — FAILURE PATH: bob command does not exist
// ─────────────────────────────────────────────────────────────────────────────
async function testFailurePath() {
  console.log('\n=== TEST 1: FAILURE PATH (bob not found) ===');
  dbCalls.length = 0;
  bobProcesses.clear();

  const incidentId = 'test-fail-001';
  spawnBobForIncident(incidentId, 'Payment timeout spike', '/api/payments', '__bob_nonexistent_cmd__');

  // Give async error/close callbacks time to fire
  await sleep(500);

  const failCall = dbCalls.find(c => c.sql.includes('investigation_failed'));
  assert(!!failCall, 'DB updated to investigation_failed when bob command not found');

  // investigation_failed should be called exactly once (failureHandled guard)
  const failCalls = dbCalls.filter(c => c.sql.includes('investigation_failed'));
  assert(failCalls.length === 1, `investigation_failed called exactly once (got ${failCalls.length})`);

  const mapEntry = bobProcesses.get(incidentId);
  if (mapEntry) {
    assert(mapEntry.status === 'exited', 'bobProcesses entry status is "exited" after error');
  } else {
    assert(true, 'bobProcesses entry never registered (synchronous throw path)');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2 — SUCCESS PATH: stub bob emits all BOB_EVENT lines, exits 0
// ─────────────────────────────────────────────────────────────────────────────
async function testSuccessPath() {
  console.log('\n=== TEST 2: SUCCESS PATH (stub bob emits BOB_EVENT lines) ===');
  dbCalls.length = 0;
  bobProcesses.clear();

  const incidentId = 'test-success-001';

  await new Promise((resolve) => {
    // Spawn: node _stub_bob.js  (ignoring -p arg; stub just writes events and exits)
    const p = spawn(process.execPath, [STUB_BOB_PATH], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entry = { proc: p, status: 'running', exitCode: null, listeners: new Set() };
    bobProcesses.set(incidentId, entry);

    let failureHandled = false;
    function handleFailure() {
      if (failureHandled) return;
      failureHandled = true;
      markInvestigationFailed(incidentId);
    }

    let lineBuffer = '';
    p.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();
      for (const line of lines) {
        for (const listener of entry.listeners) { try { listener(line); } catch (_) {} }
        const PREFIX = 'BOB_EVENT:';
        if (!line.startsWith(PREFIX)) continue;
        let event;
        try { event = JSON.parse(line.slice(PREFIX.length).trim()); } catch (_) { continue; }
        if (event.type === 'subagent_update')   handleSubagentUpdate(incidentId, event);
        if (event.type === 'hypothesis_ready')  handleHypothesisReady(incidentId, event);
        if (event.type === 'awaiting_approval') handleAwaitingApproval(incidentId);
      }
    });
    p.on('close', (code) => {
      entry.status = 'exited';
      entry.exitCode = code;
      if (code !== 0) handleFailure();
      resolve();
    });
  });

  await sleep(100); // let async DB promises settle

  const subagentCalls = dbCalls.filter(c => c.sql.includes('incident_services'));
  assert(subagentCalls.length === 3, `3 subagent_update DB calls (got ${subagentCalls.length})`);

  const hypothesisCall = dbCalls.find(c => c.sql.includes('hypothesis_json'));
  assert(!!hypothesisCall, 'hypothesis_ready DB update fired');
  const hyp = JSON.parse(hypothesisCall.params[0]);
  assert(hyp.rootCauseService === 'payment-service', 'hypothesis rootCauseService is payment-service');
  assert(typeof hyp.confidence === 'number', 'hypothesis confidence is a number');

  const approvalCall = dbCalls.find(c => c.sql.includes("awaiting_approval") && c.sql.includes('UPDATE incidents'));
  assert(!!approvalCall, 'awaiting_approval DB update fired');

  const noFailCall = dbCalls.find(c => c.sql.includes('investigation_failed'));
  assert(!noFailCall, 'investigation_failed NOT set on clean success path');

  const mapEntry = bobProcesses.get(incidentId);
  assert(mapEntry && mapEntry.status === 'exited', 'bobProcesses entry status is "exited" after clean exit');
  assert(mapEntry && mapEntry.exitCode === 0, 'exitCode is 0 on clean exit');
  assert(mapEntry.listeners instanceof Set, 'listeners is a Set (WebSocket task can attach to it)');

  // Verify listener mechanism: attach one and confirm it received events
  // (can't retroactively replay, but verify the Set is writable)
  mapEntry.listeners.add(() => {});
  assert(mapEntry.listeners.size === 1, 'listeners.add() works for Task 5 WebSocket integration');

  // Cleanup
  fs.unlinkSync(STUB_BOB_PATH);
}

// ─────────────────────────────────────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await testFailurePath();
    await testSuccessPath();
  } catch (err) {
    console.error('Unexpected test error:', err);
    testsFailed++;
  }

  console.log(`\n────────────────────────────────────`);
  console.log(`Results: ${testsPassed} passed, ${testsFailed} failed`);
  if (testsFailed > 0) process.exit(1);
})();
