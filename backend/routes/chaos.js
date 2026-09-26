// backend/routes/chaos.js
// Chaos endpoints — dev-only, require approver role.
//
// Contract (shared_contract.md):
//   POST /api/chaos/inject  { "service": "payment-service", "timeoutMs": number }
//                           → { "status": "injected" }
//   POST /api/chaos/reset   (no body)
//                           → { "status": "reset" }
//
// Mechanism:
//   1. Locate cloudops-sample-infra/ via INFRA_REPO_PATH env var or the
//      default sibling-folder path (../cloudops-sample-infra/ relative to
//      this project's root, matching the pattern documented in shared_contract.md).
//   2. Read the existing .env in that directory, update (or insert) the
//      DOWNSTREAM_TIMEOUT_MS line without wiping any other variables.
//   3. Run `docker compose up -d payment-service` from within that directory
//      and wait for the command to complete before responding.

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

// ── Resolve infra repo root ──────────────────────────────────────────────────
// Mirrors the pattern in shared_contract.md:
//   INFRA_REPO_PATH env var → override
//   default: ../cloudops-sample-infra/ (sibling of cloudops-rca/)
const INFRA_REPO_PATH = process.env.INFRA_REPO_PATH
  ? path.resolve(process.env.INFRA_REPO_PATH)
  : path.resolve(__dirname, '../../../../cloudops-sample-infra');

const INFRA_ENV_FILE = path.join(INFRA_REPO_PATH, '.env');

const DEFAULT_TIMEOUT_MS = 5000;

// ── Helper: rewrite DOWNSTREAM_TIMEOUT_MS in the infra .env ─────────────────
// Reads the existing file (creates it if absent), updates or inserts the one
// variable, and writes back — leaving every other line untouched.
function setDownstreamTimeout(timeoutMs) {
  let contents = '';
  try {
    contents = fs.readFileSync(INFRA_ENV_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // File doesn't exist yet — start with an empty string; we'll create it.
  }

  const KEY = 'DOWNSTREAM_TIMEOUT_MS';
  const newLine = `${KEY}=${timeoutMs}`;
  const lines = contents.split('\n');
  let found = false;

  const updated = lines.map((line) => {
    if (line.trimStart().startsWith(`${KEY}=`) || line.trimStart().startsWith(`${KEY} =`)) {
      found = true;
      return newLine;
    }
    return line;
  });

  if (!found) {
    // Ensure file ends with a newline before appending
    if (updated[updated.length - 1] !== '') updated.push('');
    updated.push(newLine);
  }

  fs.writeFileSync(INFRA_ENV_FILE, updated.join('\n'), 'utf8');
}

// ── Helper: run `docker compose up -d <service>` in the infra dir ─────────
// Wraps execFile so we can await it and get stdout/stderr in case of errors.
function dockerComposeUp(service) {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['compose', 'up', '-d', service],
      { cwd: INFRA_REPO_PATH },
      (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(err, { stdout, stderr }));
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
  });
}

// ── POST /api/chaos/inject ────────────────────────────────────────────────────
router.post('/inject', requireRole('approver'), async (req, res) => {
  const { service = 'payment-service', timeoutMs } = req.body;

  if (typeof timeoutMs !== 'number' || timeoutMs < 0) {
    return res.status(400).json({ error: 'timeoutMs must be a non-negative number' });
  }

  console.log(`[chaos] inject: ${service} DOWNSTREAM_TIMEOUT_MS=${timeoutMs}`);

  try {
    setDownstreamTimeout(timeoutMs);
  } catch (err) {
    console.error('[chaos] Failed to write .env:', err.message);
    return res.status(500).json({ error: `Failed to write infra .env: ${err.message}` });
  }

  try {
    const { stdout, stderr } = await dockerComposeUp(service);
    if (stdout) console.log(`[chaos] docker compose stdout: ${stdout.trim()}`);
    if (stderr) console.log(`[chaos] docker compose stderr: ${stderr.trim()}`);
  } catch (err) {
    console.error('[chaos] docker compose up failed:', err.message, err.stderr);
    return res.status(500).json({
      error: `docker compose up failed: ${err.message}`,
      detail: err.stderr || '',
    });
  }

  return res.json({ status: 'injected' });
});

// ── POST /api/chaos/reset ─────────────────────────────────────────────────────
router.post('/reset', requireRole('approver'), async (req, res) => {
  console.log(`[chaos] reset: DOWNSTREAM_TIMEOUT_MS → ${DEFAULT_TIMEOUT_MS}`);

  try {
    setDownstreamTimeout(DEFAULT_TIMEOUT_MS);
  } catch (err) {
    console.error('[chaos] Failed to write .env:', err.message);
    return res.status(500).json({ error: `Failed to write infra .env: ${err.message}` });
  }

  try {
    const { stdout, stderr } = await dockerComposeUp('payment-service');
    if (stdout) console.log(`[chaos] docker compose stdout: ${stdout.trim()}`);
    if (stderr) console.log(`[chaos] docker compose stderr: ${stderr.trim()}`);
  } catch (err) {
    console.error('[chaos] docker compose up failed:', err.message, err.stderr);
    return res.status(500).json({
      error: `docker compose up failed: ${err.message}`,
      detail: err.stderr || '',
    });
  }

  return res.json({ status: 'reset' });
});

module.exports = router;
