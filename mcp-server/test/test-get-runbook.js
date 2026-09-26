/**
 * Standalone test for getRunbook.
 *
 * Run from the repo root:
 *   node mcp-server/test/test-get-runbook.js
 *
 * Or with a custom infra path:
 *   INFRA_REPO_PATH=/path/to/cloudops-sample-infra node mcp-server/test/test-get-runbook.js
 */

import { getRunbook, RUNBOOKS_DIR } from "../lib/getRunbook.js";
import { existsSync } from "fs";

// Use the exact same path the real tool uses — no duplicated resolution.
console.log(`\n  Runbooks dir: ${RUNBOOKS_DIR}`);

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

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------
console.log("\n── Pre-flight: runbooks directory exists ────────────────────");
assert(existsSync(RUNBOOKS_DIR), `runbooks dir found at ${RUNBOOKS_DIR}`);

if (!existsSync(RUNBOOKS_DIR)) {
  console.error(
    "\nCannot continue — set INFRA_REPO_PATH to point at your cloudops-sample-infra clone.\n"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Test 1: known services return real Markdown content
// ---------------------------------------------------------------------------
const KNOWN_SERVICES = [
  "api-gateway",
  "order-service",
  "payment-service",
  "inventory-service",
];

for (const svc of KNOWN_SERVICES) {
  console.log(`\n── get_runbook("${svc}") ─────────────────────────────────`);
  const result = getRunbook({ service: svc });

  assert(typeof result === "string", "returns a string");
  assert(result.length > 0, "string is non-empty");
  assert(!result.startsWith("No runbook found"), "is not an error message");
  assert(result.includes("#"), "contains at least one Markdown heading");

  // Print the first line for visual confirmation
  const firstLine = result.split("\n")[0];
  console.log(`  first line: ${firstLine}`);
}

// ---------------------------------------------------------------------------
// Test 2: unknown service returns a descriptive error string, not a throw
// ---------------------------------------------------------------------------
console.log("\n── get_runbook(unknown service) ──────────────────────────────");
let threw = false;
let errorResult;
try {
  errorResult = getRunbook({ service: "nonexistent-service-xyz" });
} catch {
  threw = true;
}

assert(!threw, "does not throw for unknown service");
assert(typeof errorResult === "string", "returns a string");
assert(
  errorResult.startsWith('No runbook found for service "nonexistent-service-xyz"'),
  'error message starts with \'No runbook found for service "nonexistent-service-xyz"\''
);
assert(
  KNOWN_SERVICES.every((svc) => errorResult.includes(svc)),
  "error message lists all available services"
);
console.log(`  error message: ${errorResult}`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"─".repeat(56)}`);
console.log(`  ${passed} passed  |  ${failed} failed`);
console.log("─".repeat(56));

process.exit(failed > 0 ? 1 : 0);
