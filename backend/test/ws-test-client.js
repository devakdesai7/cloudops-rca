#!/usr/bin/env node
// backend/test/ws-test-client.js
//
// End-to-end integration test for the WebSocket live-streaming feature.
//
// What it does:
//   1. Logs in to get a JWT token
//   2. POSTs to /api/incidents/trigger to start an incident
//      (a stub "bob" script emits BOB_EVENT lines and exits cleanly)
//   3. Connects TWO WebSocket clients to ws://localhost:4000/ws/incidents/:id
//      (tests the multi-client broadcast case)
//   4. Asserts that BOTH clients receive all five expected events in order
//   5. Prints a clear pass/fail summary
//
// The stub bob is written to a temp file and passed via BOB_CMD env var so
// the real server binary is not modified. The server must be started with
// BOB_CMD pointing at the stub, OR this script temporarily monkey-patches
// the spawn call — but since the server is external, we use a wrapper shim.
//
// ── Fastest way to run this test ──────────────────────────────────────────────
//
//   Terminal 1 (start server with stub bob on PATH):
//     cd cloudops-rca/backend
//     node test/ws-test-client.js --self-contained
//
// With --self-contained the script:
//   • Writes a stub bob.cmd / bob shim to a temp dir
//   • Starts the backend server as a child process with the temp dir prepended
//     to PATH so "bob" resolves to the stub
//   • Runs the WS test against it
//   • Kills the server when done
//
// ── Without --self-contained (server already running with real bob) ──────────
//   node test/ws-test-client.js --incident-id <uuid>
//   (connects WS only — assumes bob already running for that incident)
//
// ── Env vars ──────────────────────────────────────────────────────────────────
//   BASE_URL    default http://localhost:4000
//   LOGIN_EMAIL default admin@example.com
//   LOGIN_PASS  default password

'use strict';

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { spawn }  = require('child_process');
const { WebSocket } = require('ws');

const BASE_URL    = process.env.BASE_URL    || 'http://localhost:4000';
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || 'approver@demo.com';
const LOGIN_PASS  = process.env.LOGIN_PASS  || 'approver123';

const SELF_CONTAINED = process.argv.includes('--self-contained');
const INCIDENT_ID_ARG = (() => {
  const idx = process.argv.indexOf('--incident-id');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

// ── Tiny test harness ─────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++; }
  else           { console.error(`  ✗ FAIL: ${msg}`); failed++; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function request(method, urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── WS helper: connect and collect events until done or timeout ───────────────
function connectWs(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const events = [];
    const ws = new WebSocket(url);
    let timer;

    function finish() {
      clearTimeout(timer);
      ws.close();
      resolve(events);
    }

    timer = setTimeout(() => {
      console.warn(`  [ws] Timeout after ${timeoutMs}ms — collected ${events.length} events`);
      finish();
    }, timeoutMs);

    ws.on('open',    ()    => console.log(`  [ws] Connected to ${url}`));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        console.log(`  [ws] ← ${JSON.stringify(msg)}`);
        events.push(msg);
        // Stop collecting after awaiting_approval (the last expected BOB_EVENT)
        if (msg.type === 'awaiting_approval') finish();
      } catch (e) {
        console.warn('  [ws] Bad JSON:', raw.toString());
      }
    });
    ws.on('error',   (e)   => console.error('  [ws] error:', e.message));
    ws.on('close',   ()    => { clearTimeout(timer); resolve(events); });
  });
}

// ── Stub bob script ───────────────────────────────────────────────────────────
function writeStubBob(dir) {
  // The stub: emits BOB_EVENT lines then exits 0
  const stubJs = path.join(dir, '_stub_bob_ws.js');
  fs.writeFileSync(stubJs, `#!/usr/bin/env node
// Stub Bob for WS integration test — emits BOB_EVENT lines with a small delay
// between each to simulate a real incremental workflow.
const lines = [
  'BOB_EVENT:{"type":"subagent_update","service":"payment-service","status":"investigating"}',
  'BOB_EVENT:{"type":"subagent_update","service":"order-service","status":"investigating"}',
  'BOB_EVENT:{"type":"subagent_update","service":"payment-service","status":"done","verdict":"suspicious deploy at 13:58 UTC"}',
  'BOB_EVENT:{"type":"subagent_update","service":"order-service","status":"done","verdict":"no anomalies found"}',
  'BOB_EVENT:{"type":"hypothesis_ready","hypothesis":{"rootCauseService":"payment-service","explanation":"Timeout config reduced in last deploy","confidence":0.92,"evidenceRefs":["log-abc","commit-xyz"]}}',
  'BOB_EVENT:{"type":"awaiting_approval"}',
];
(async () => {
  for (const line of lines) {
    process.stdout.write(line + '\\n');
    await new Promise(r => setTimeout(r, 120));
  }
  process.exit(0);
})();
`);

  // On Windows, create a .cmd wrapper so 'bob' resolves on PATH
  if (process.platform === 'win32') {
    const stubCmd = path.join(dir, 'bob.cmd');
    fs.writeFileSync(stubCmd, `@node "${stubJs}" %*\r\n`);
  } else {
    // Unix: write a shell wrapper named 'bob'
    const stubSh = path.join(dir, 'bob');
    fs.writeFileSync(stubSh, `#!/bin/sh\nexec node "${stubJs}" "$@"\n`);
    fs.chmodSync(stubSh, 0o755);
  }
  return dir;
}

// ── Self-contained mode: start backend server with stub bob ───────────────────
function startServerWithStub(stubDir) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
      // Ensure dotenv loads the real .env
    };

    const serverProc = spawn(
      process.execPath,
      [path.join(__dirname, '..', 'index.js')],
      {
        cwd:   path.join(__dirname, '..'),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let ready = false;
    let output = '';

    serverProc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      output += s;
      process.stdout.write(`  [server] ${s}`);
      if (!ready && s.includes('listening on')) {
        ready = true;
        setTimeout(() => resolve(serverProc), 300); // tiny settle delay
      }
    });
    serverProc.stderr.on('data', (chunk) => {
      process.stderr.write(`  [server-err] ${chunk}`);
    });
    serverProc.on('error', reject);
    serverProc.on('close', (code) => {
      if (!ready) reject(new Error(`Server exited before ready (code ${code})\n${output}`));
    });

    setTimeout(() => {
      if (!ready) reject(new Error('Server did not start within 10s'));
    }, 10000);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  let serverProc = null;
  let stubDir    = null;

  try {
    // ── Setup ────────────────────────────────────────────────────────────────
    if (SELF_CONTAINED) {
      stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-bob-'));
      writeStubBob(stubDir);
      console.log(`\n[setup] Stub bob written to ${stubDir}`);
      console.log('[setup] Starting backend server with stub bob on PATH…');
      serverProc = await startServerWithStub(stubDir);
      console.log('[setup] Server ready.\n');
      await sleep(500);
    }

    // ── Step 1: Login ─────────────────────────────────────────────────────────
    if (INCIDENT_ID_ARG) {
      // Skip login+trigger, go straight to WS test
      console.log(`\n=== WS-ONLY MODE: incident ${INCIDENT_ID_ARG} ===`);
      const wsUrl = BASE_URL.replace(/^http/, 'ws') + `/ws/incidents/${INCIDENT_ID_ARG}`;
      console.log('[client A] Connecting…');
      const events = await connectWs(wsUrl, 20000);
      assert(events.length > 0, `Received at least 1 WS event (got ${events.length})`);
    } else {
      console.log('\n=== STEP 1: Login ===');
      const loginRes = await request('POST', `${BASE_URL}/api/auth/login`, {
        email: LOGIN_EMAIL, password: LOGIN_PASS,
      });
      assert(loginRes.status === 200, `Login returned 200 (got ${loginRes.status})`);
      const token = loginRes.body?.token;
      assert(!!token, 'Login returned a JWT token');

      // ── Step 2: Trigger incident ────────────────────────────────────────────
      console.log('\n=== STEP 2: Trigger incident ===');
      const triggerRes = await request(
        'POST',
        `${BASE_URL}/api/incidents/trigger`,
        { summary: 'WS test: payment timeout spike', affectedEndpoint: '/api/payments/checkout' },
        { Authorization: `Bearer ${token}` }
      );
      assert(triggerRes.status === 201, `Trigger returned 201 (got ${triggerRes.status})`);
      const incidentId = triggerRes.body?.incidentId;
      assert(!!incidentId, `Trigger returned incidentId (got ${incidentId})`);
      assert(triggerRes.body?.status === 'triage_started', 'Trigger status is triage_started');
      console.log(`  incidentId: ${incidentId}`);

      // ── Step 3: Connect TWO WS clients concurrently ─────────────────────────
      console.log('\n=== STEP 3: Connect two WS clients (multi-client broadcast test) ===');
      const wsBase = BASE_URL.replace(/^http/, 'ws');
      const wsUrl  = `${wsBase}/ws/incidents/${incidentId}`;
      console.log(`  Connecting client A and client B to: ${wsUrl}`);

      // Both clients connect simultaneously; Bob fires after a small delay
      // so both are subscribed before events arrive.
      const [eventsA, eventsB] = await Promise.all([
        connectWs(wsUrl, 15000),
        connectWs(wsUrl, 15000),
      ]);

      // ── Step 4: Assertions ──────────────────────────────────────────────────
      console.log('\n=== STEP 4: Assertions ===');

      // Both clients get a 'connected' ack first
      assert(eventsA[0]?.type === 'connected', 'Client A: first message is "connected" ack');
      assert(eventsB[0]?.type === 'connected', 'Client B: first message is "connected" ack');

      // Strip the 'connected' ack for event-shape checks
      const payloadA = eventsA.filter(e => e.type !== 'connected');
      const payloadB = eventsB.filter(e => e.type !== 'connected');

      assert(payloadA.length >= 5, `Client A: received ≥5 BOB_EVENT messages (got ${payloadA.length})`);
      assert(payloadB.length >= 5, `Client B: received ≥5 BOB_EVENT messages (got ${payloadB.length})`);

      // Check event types match in both clients
      const typesA = payloadA.map(e => e.type).join(',');
      const typesB = payloadB.map(e => e.type).join(',');
      assert(typesA === typesB, `Both clients received the same event sequence\n    A: ${typesA}\n    B: ${typesB}`);

      // Verify specific contract shapes
      const subagentEvents = payloadA.filter(e => e.type === 'subagent_update');
      assert(subagentEvents.length >= 2, `≥2 subagent_update events (got ${subagentEvents.length})`);
      if (subagentEvents.length > 0) {
        const sampleSub = subagentEvents[0];
        assert(typeof sampleSub.service === 'string', 'subagent_update has "service" string');
        assert(['queued','investigating','done'].includes(sampleSub.status),
          `subagent_update.status is valid (got "${sampleSub.status}")`);
        assert('verdict' in sampleSub, 'subagent_update has "verdict" field');
      }

      const hypothesisEvent = payloadA.find(e => e.type === 'hypothesis_ready');
      assert(!!hypothesisEvent, 'hypothesis_ready event received');
      if (hypothesisEvent) {
        assert(typeof hypothesisEvent.hypothesis?.rootCauseService === 'string',
          'hypothesis_ready.hypothesis.rootCauseService is a string');
        assert(typeof hypothesisEvent.hypothesis?.confidence === 'number',
          'hypothesis_ready.hypothesis.confidence is a number');
      }

      const awaitingEvent = payloadA.find(e => e.type === 'awaiting_approval');
      assert(!!awaitingEvent, 'awaiting_approval event received');
      if (awaitingEvent) {
        assert(Object.keys(awaitingEvent).length === 1,
          'awaiting_approval has exactly one key ("type")');
      }
    }

  } catch (err) {
    console.error('\nUnexpected error:', err.message);
    failed++;
  } finally {
    // ── Teardown ───────────────────────────────────────────────────────────
    if (serverProc) {
      serverProc.kill();
      console.log('\n[teardown] Server stopped.');
    }
    if (stubDir) {
      fs.rmSync(stubDir, { recursive: true, force: true });
      console.log('[teardown] Stub files removed.');
    }

    console.log(`\n────────────────────────────────────`);
    console.log(`WS test results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
