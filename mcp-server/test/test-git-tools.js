/**
 * Standalone test for getRecentCommits and checkDeployHistory.
 *
 * Calls the functions directly (not through MCP) against the real
 * cloudops-sample-infra git repo.
 *
 * Run from the repo root:
 *   node mcp-server/test/test-git-tools.js
 *
 * Or from inside mcp-server/:
 *   node test/test-git-tools.js
 */

import { execFileSync } from "child_process";
import { getRecentCommits, checkDeployHistory, INFRA_REPO } from "../lib/gitLog.js";

// Use the exact same path that the real git tools use — resolved once in
// gitLog.js, respecting the INFRA_REPO_PATH env var if set.
const REPO_PATH = INFRA_REPO;

const SERVICE = "payment-service";

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
// Pre-flight: confirm the repo exists and has commits for this service
// ---------------------------------------------------------------------------
console.log(`\n── Pre-flight check ─────────────────────────────────────`);

let repoExists = false;
try {
  execFileSync("git", ["-C", REPO_PATH, "rev-parse", "--git-dir"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  repoExists = true;
} catch {
  // ignore
}

assert(repoExists, `repo found at ${REPO_PATH}`);

if (!repoExists) {
  console.error(
    "\nCannot continue — cloudops-sample-infra repo not found at:\n" +
      `  ${REPO_PATH}\n`
  );
  process.exit(1);
}

// Count commits for this service
const rawCount = execFileSync(
  "git",
  ["-C", REPO_PATH, "rev-list", "--count", "HEAD", "--", `services/${SERVICE}/`],
  { encoding: "utf8" }
).trim();

const commitCount = parseInt(rawCount, 10);
console.log(`  ℹ services/${SERVICE}/ has ${commitCount} commit(s) in repo`);

if (commitCount === 0) {
  console.error(
    `\n⚠  No commits found for services/${SERVICE}/ in cloudops-sample-infra.\n` +
      `   You need to seed at least one commit touching that path before\n` +
      `   these tools will return real data.\n` +
      `   Example:\n` +
      `     cd D:\\Projects\\ibm_bob_hackathon\\cloudops-sample-infra\n` +
      `     echo "" >> services/payment-service/README.md\n` +
      `     git add services/payment-service/\n` +
      `     git commit -m "seed: initial payment-service commit"\n`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Test getRecentCommits (no since filter)
// ---------------------------------------------------------------------------
console.log(`\n── getRecentCommits("${SERVICE}") ─────────────────────────`);

const commits = getRecentCommits({ service: SERVICE, repoPath: REPO_PATH });

assert(Array.isArray(commits), "returns an array");
assert(commits.length > 0, `at least one commit returned (got ${commits.length})`);

if (commits.length > 0) {
  const c = commits[0];
  assert(typeof c.sha === "string" && c.sha.length === 40, "sha is 40-char hex");
  assert(typeof c.message === "string" && c.message.length > 0, "message is non-empty string");
  assert(typeof c.author === "string" && c.author.length > 0, "author is non-empty string");
  assert(typeof c.date === "string" && c.date.length > 0, "date is non-empty string");
  assert(Array.isArray(c.filesChanged), "filesChanged is an array");
  if (c.filesChanged.length > 0) {
    assert(
      c.filesChanged.every((f) => f.startsWith(`services/${SERVICE}/`)),
      `all filesChanged are scoped to services/${SERVICE}/`
    );
  }

  console.log(`\n  All ${commits.length} commit(s):`);
  for (const commit of commits) {
    console.log(`\n  ┌ sha:     ${commit.sha}`);
    console.log(`  │ message: ${commit.message}`);
    console.log(`  │ author:  ${commit.author}`);
    console.log(`  │ date:    ${commit.date}`);
    console.log(`  └ files:   ${commit.filesChanged.join(", ") || "(none in service folder)"}`);
  }
}

// ---------------------------------------------------------------------------
// Test getRecentCommits with `since` filter
// ---------------------------------------------------------------------------
console.log(`\n── getRecentCommits("${SERVICE}", since=future) ───────────`);
const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
const commitsAfterFuture = getRecentCommits({
  service: SERVICE,
  since: future,
  repoPath: REPO_PATH,
});
assert(Array.isArray(commitsAfterFuture), "returns an array");
assert(commitsAfterFuture.length === 0, "filtering to future date returns 0 commits");

// Filter to a date before earliest commit → should return all commits
const earliest = commits[commits.length - 1]?.date;
if (earliest) {
  const beforeEarliest = new Date(new Date(earliest).getTime() - 1000).toISOString();
  const commitsAfterEarliest = getRecentCommits({
    service: SERVICE,
    since: beforeEarliest,
    repoPath: REPO_PATH,
  });
  assert(
    commitsAfterEarliest.length === commits.length,
    `since just before earliest returns all ${commits.length} commit(s)`
  );
}

// ---------------------------------------------------------------------------
// Test checkDeployHistory
// ---------------------------------------------------------------------------
console.log(`\n── checkDeployHistory("${SERVICE}") ────────────────────────`);

const history = checkDeployHistory({ service: SERVICE, repoPath: REPO_PATH });

assert(Array.isArray(history), "returns an array");
assert(history.length === commits.length, `same count as getRecentCommits (${commits.length})`);

if (history.length > 0) {
  const h = history[0];
  assert(typeof h.timestamp === "string" && h.timestamp.length > 0, "timestamp is non-empty string");
  assert(typeof h.commitSha === "string" && h.commitSha.length === 40, "commitSha is 40-char hex");
  assert(typeof h.description === "string" && h.description.length > 0, "description is non-empty string");

  // Newest first: first entry date should be >= last entry date
  if (history.length > 1) {
    assert(
      history[0].timestamp >= history[history.length - 1].timestamp,
      "entries are newest-first"
    );
  }

  console.log(`\n  All ${history.length} deploy(s):`);
  for (const entry of history) {
    console.log(`\n  ┌ timestamp:  ${entry.timestamp}`);
    console.log(`  │ commitSha:  ${entry.commitSha}`);
    console.log(`  └ description: ${entry.description}`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"─".repeat(56)}`);
console.log(`  ${passed} passed  |  ${failed} failed`);
console.log("─".repeat(56));

process.exit(failed > 0 ? 1 : 0);
