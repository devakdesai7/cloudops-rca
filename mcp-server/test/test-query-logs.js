/**
 * Standalone test for queryLogs against the real shared-logs.db.
 *
 * Run from the repo root:
 *   node mcp-server/test/test-query-logs.js
 *
 * Or from inside mcp-server/:
 *   node test/test-query-logs.js
 *
 * No test framework required — prints results and exits non-zero on failure.
 */

import { existsSync } from "fs";
import { queryLogs, DEFAULT_DB_PATH } from "../lib/queryLogs.js";

// Use the exact same path that the real queryLogs tool uses — resolved once
// in queryLogs.js, respecting the LOG_DB_PATH env var if set.
const DB_PATH = DEFAULT_DB_PATH;

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
// 1. DB existence check
// ---------------------------------------------------------------------------
console.log("\n── Test 1: DB file exists on host ──────────────────────────");
assert(existsSync(DB_PATH), `DB found at ${DB_PATH}`);

if (!existsSync(DB_PATH)) {
  console.error(
    "\nCannot continue — start the sample-infra containers first:\n" +
      "  cd ../cloudops-sample-infra && docker compose up -d\n"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Missing DB path returns empty array (graceful degradation)
// ---------------------------------------------------------------------------
console.log("\n── Test 2: non-existent DB returns [] ──────────────────────");
const missingResult = queryLogs({
  service: "payment-service",
  dbPath: "/nonexistent/path/shared-logs.db",
});
assert(Array.isArray(missingResult), "returns an array");
assert(missingResult.length === 0, "array is empty");

// ---------------------------------------------------------------------------
// 3. Query all rows for each known service
// ---------------------------------------------------------------------------
const services = [
  "api-gateway",
  "order-service",
  "payment-service",
  "inventory-service",
];

for (const svc of services) {
  console.log(`\n── Test 3.${services.indexOf(svc) + 1}: query_logs for ${svc} ─`);
  const rows = queryLogs({ service: svc, dbPath: DB_PATH });
  assert(Array.isArray(rows), "returns an array");
  console.log(`     row count: ${rows.length}`);

  if (rows.length > 0) {
    const first = rows[0];
    assert(typeof first.timestamp === "string", "row.timestamp is a string");
    assert(first.service === svc, `row.service === "${svc}"`);
    assert(typeof first.level === "string", "row.level is a string");
    assert("trace_id" in first, "row has trace_id field");
    assert(typeof first.message === "string", "row.message is a string");
    assert(
      first.meta === null || typeof first.meta === "object",
      "row.meta is object or null (parsed from JSON)"
    );

    // Print a sample row for visual inspection
    console.log("\n     Sample row:");
    console.log(JSON.stringify(first, null, 4).replace(/^/gm, "     "));
  } else {
    console.log("     (no rows — service may not have logged yet)");
  }
}

// ---------------------------------------------------------------------------
// 4. Timestamp range filter
// ---------------------------------------------------------------------------
console.log("\n── Test 4: timestamp range filter ──────────────────────────");
const allRows = queryLogs({ service: "payment-service", dbPath: DB_PATH });
if (allRows.length >= 2) {
  const midIndex = Math.floor(allRows.length / 2);
  const midTimestamp = allRows[midIndex].timestamp;

  const afterMid = queryLogs({
    service: "payment-service",
    start_time: midTimestamp,
    dbPath: DB_PATH,
  });
  assert(
    afterMid.length <= allRows.length,
    "start_time filter reduces result set"
  );
  assert(
    afterMid.every((r) => r.timestamp >= midTimestamp),
    "all rows have timestamp >= start_time"
  );

  const beforeMid = queryLogs({
    service: "payment-service",
    end_time: midTimestamp,
    dbPath: DB_PATH,
  });
  assert(
    beforeMid.every((r) => r.timestamp <= midTimestamp),
    "all rows have timestamp <= end_time"
  );

  console.log(
    `     total=${allRows.length}  after_mid=${afterMid.length}  before_mid=${beforeMid.length}`
  );
} else {
  console.log("     (skipped — need >= 2 rows for range test)");
}

// ---------------------------------------------------------------------------
// 5. trace_id filter
// ---------------------------------------------------------------------------
console.log("\n── Test 5: trace_id filter ──────────────────────────────────");
const rowsWithTrace = allRows.filter((r) => r.trace_id);
if (rowsWithTrace.length > 0) {
  const targetTrace = rowsWithTrace[0].trace_id;
  const filtered = queryLogs({
    service: "payment-service",
    trace_id: targetTrace,
    dbPath: DB_PATH,
  });
  assert(filtered.length > 0, `rows returned for trace_id="${targetTrace}"`);
  assert(
    filtered.every((r) => r.trace_id === targetTrace),
    "all rows match the requested trace_id"
  );
  console.log(`     trace_id="${targetTrace}"  matches=${filtered.length}`);
} else {
  console.log("     (skipped — no rows with a trace_id found)");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"─".repeat(56)}`);
console.log(`  ${passed} passed  |  ${failed} failed`);
console.log("─".repeat(56));

process.exit(failed > 0 ? 1 : 0);
