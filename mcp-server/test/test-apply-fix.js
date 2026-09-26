/**
 * Standalone test for applyFix.
 *
 * Tests the safety-rejection paths and the config_change path end-to-end.
 * The revert path is validated for input-rejection only (we don't want to
 * create spurious git commits in CI).
 *
 * Run from repo root:
 *   INFRA_REPO_PATH=D:\Projects\cloudops-sample-infra node mcp-server/test/test-apply-fix.js
 */

import { applyFix } from "../lib/applyFix.js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

const INFRA_REPO =
  process.env.INFRA_REPO_PATH ??
  (() => {
    throw new Error(
      "Set INFRA_REPO_PATH env var before running this test.\n" +
        "  e.g.  INFRA_REPO_PATH=D:\\Projects\\cloudops-sample-infra node mcp-server/test/test-apply-fix.js"
    );
  })();

const ENV_FILE = resolve(INFRA_REPO, ".env");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function readEnvVar(key) {
  if (!existsSync(ENV_FILE)) return undefined;
  const content = readFileSync(ENV_FILE, "utf8");
  const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1] : undefined;
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------
console.log("\n── Pre-flight ───────────────────────────────────────────────");
assert(existsSync(INFRA_REPO), `infra repo found at ${INFRA_REPO}`);
assert(existsSync(ENV_FILE), `.env file exists at ${ENV_FILE}`);
console.log(`  current DOWNSTREAM_TIMEOUT_MS = ${readEnvVar("DOWNSTREAM_TIMEOUT_MS") ?? "(not set)"}`);

// ---------------------------------------------------------------------------
// Test 1: invalid action is rejected without executing anything
// ---------------------------------------------------------------------------
console.log("\n── Test 1: invalid action rejected ──────────────────────────");
const badAction = applyFix({
  service: "payment-service",
  commitSha: "abc1234",
  action: "rm -rf /",
  infraRepo: INFRA_REPO,
});
assert(badAction.status === "error", 'status === "error"');
assert(
  badAction.message.includes("Unknown action"),
  'message contains "Unknown action"'
);
console.log(`  message: ${badAction.message}`);

// ---------------------------------------------------------------------------
// Test 2: invalid SHA rejected before git is called
// ---------------------------------------------------------------------------
console.log("\n── Test 2: invalid SHA rejected ─────────────────────────────");
const badSha = applyFix({
  service: "payment-service",
  commitSha: "'; rm -rf /; echo '",
  action: "revert",
  infraRepo: INFRA_REPO,
});
assert(badSha.status === "error", 'status === "error"');
assert(
  badSha.message.includes("Invalid commitSha"),
  'message contains "Invalid commitSha"'
);
console.log(`  message: ${badSha.message}`);

// ---------------------------------------------------------------------------
// Test 3: disallowed env var rejected
// ---------------------------------------------------------------------------
console.log("\n── Test 3: disallowed env var rejected ──────────────────────");
const badVar = applyFix({
  service: "payment-service",
  commitSha: "abc1234",
  action: "config_change",
  details: { envVar: "PATH", newValue: "/evil" },
  infraRepo: INFRA_REPO,
});
assert(badVar.status === "error", 'status === "error"');
assert(
  badVar.message.includes("not on the env var allowlist"),
  'message contains "not on the env var allowlist"'
);
console.log(`  message: ${badVar.message}`);

// ---------------------------------------------------------------------------
// Test 4: config_change — set DOWNSTREAM_TIMEOUT_MS to 5000 end-to-end
// ---------------------------------------------------------------------------
console.log("\n── Test 4: config_change DOWNSTREAM_TIMEOUT_MS=5000 ─────────");

// Record value before
const before = readEnvVar("DOWNSTREAM_TIMEOUT_MS");
console.log(`  value before: ${before ?? "(not set)"}`);

const result = applyFix({
  service: "payment-service",
  commitSha: "n/a",               // not used for config_change
  action: "config_change",
  details: { envVar: "DOWNSTREAM_TIMEOUT_MS", newValue: "5000" },
  infraRepo: INFRA_REPO,
});

console.log(`  status:  ${result.status}`);
console.log(`  message: ${result.message}`);

assert(result.status === "success", 'status === "success"');

// Confirm .env was updated
const after = readEnvVar("DOWNSTREAM_TIMEOUT_MS");
console.log(`  value after:  ${after ?? "(not set)"}`);
assert(after === "5000", ".env now contains DOWNSTREAM_TIMEOUT_MS=5000");

// Confirm container is running
let containerRunning = false;
try {
  const psOut = execFileSync(
    "docker",
    ["inspect", "--format", "{{.State.Status}}", "payment-service"],
    { encoding: "utf8", stdio: "pipe" }
  ).trim();
  containerRunning = psOut === "running";
  console.log(`  container status: ${psOut}`);
} catch {
  console.log("  container status: (could not inspect — docker not available)");
}
assert(containerRunning, 'payment-service container is "running" after config_change');

// ---------------------------------------------------------------------------
// Test 5: audit log was written
// ---------------------------------------------------------------------------
console.log("\n── Test 5: audit log written ────────────────────────────────");
// Audit log lives one level up from test/ inside mcp-server/
const AUDIT_LOG = resolve(__dirname, "../apply_fix_audit.log");

assert(existsSync(AUDIT_LOG), `audit log exists at ${AUDIT_LOG}`);
if (existsSync(AUDIT_LOG)) {
  const lines = readFileSync(AUDIT_LOG, "utf8").trim().split("\n");
  const lastLine = lines[lines.length - 1];
  let lastEntry;
  try {
    lastEntry = JSON.parse(lastLine);
  } catch {
    // not valid JSON
  }
  assert(!!lastEntry, "last audit log line is valid JSON");
  assert(lastEntry?.result?.status === "success", 'last audit entry result.status === "success"');
  console.log(`  last audit entry: ${lastLine}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"─".repeat(56)}`);
console.log(`  ${passed} passed  |  ${failed} failed`);
console.log("─".repeat(56));

process.exit(failed > 0 ? 1 : 0);
