/**
 * gitLog.js — git history helpers for the cloudops-sample-infra repo.
 *
 * Both functions scope git log to a single service's folder:
 *   services/<service>/
 *
 * We use child_process.execFileSync (no shell, no extra deps) and parse
 * git's output with a custom record-separator format to avoid ambiguity
 * with commit messages containing newlines.
 *
 * Repo path: read from INFRA_REPO_PATH env var so teammates with a different repo
 * layout can override without touching code. Falls back to the relative path
 * that works for the standard layout:
 *   cloudops-rca-new/cloudops-rca/mcp-server/lib/ → ../../../../cloudops-sample-infra
 */

import { execFileSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Infra repo path: read from INFRA_REPO_PATH env var so teammates with a different
// repo layout can override without touching code. Falls back to the relative path
// that works for the standard layout:
//   cloudops-rca-new/cloudops-rca/mcp-server/lib/ → ../../../../cloudops-sample-infra
const INFRA_REPO =
  process.env.INFRA_REPO_PATH ??
  resolve(__dirname, "../../../../cloudops-sample-infra");

/**
 * The resolved infra repo path this module will use by default — exported so
 * test scripts can import it instead of duplicating the resolution logic.
 */
export { INFRA_REPO };

// A delimiter that will never appear in a commit message or file path
const RS = "\x1E"; // ASCII Record Separator

/**
 * Run git log scoped to services/<service>/ and return parsed commit objects.
 *
 * Each entry in the returned array has the shape from the contract:
 *   { sha, message, author, date, filesChanged }
 *
 * @param {object} params
 * @param {string}  params.service  - service name, e.g. "payment-service"
 * @param {string} [params.since]   - ISO-8601 date; only commits strictly after this
 * @param {string} [params.repoPath] - override repo path (used by tests)
 * @returns {Array<{sha, message, author, date, filesChanged}>}
 */
export function getRecentCommits({ service, since, repoPath = INFRA_REPO }) {
  const servicePath = `services/${service}/`;

  // Format: each commit is one line of RS-delimited fields, then a blank line,
  // then the --name-only file list, then another blank line.
  // We split commits on a sentinel we place at the start of each record.
  //
  // Format string:  <sentinel><sha>RS<subject>RS<author>RS<ISO date>
  const SENTINEL = "---COMMIT---";
  const formatStr = `${SENTINEL}%H${RS}%s${RS}%an${RS}%aI`;

  const args = [
    "-C", repoPath,
    "log",
    `--format=${formatStr}`,
    "--name-only",          // list changed files after each commit header
  ];

  if (since) {
    args.push(`--after=${since}`);
  }

  // Scope to the service folder
  args.push("--");
  args.push(servicePath);

  let raw;
  try {
    raw = execFileSync("git", args, { encoding: "utf8" });
  } catch (err) {
    // git not available, or repo doesn't exist
    throw new Error(`git log failed: ${err.message}`);
  }

  if (!raw.trim()) {
    return [];
  }

  // Split on sentinel to get per-commit blocks.
  // First element before first sentinel is empty — drop it.
  const blocks = raw.split(SENTINEL).filter(Boolean);

  return blocks.map((block) => {
    // Each block looks like:
    //   "<sha>RS<message>RS<author>RS<date>\n\nfile1\nfile2\n\n"
    const newlineIdx = block.indexOf("\n");
    const headerLine = block.slice(0, newlineIdx);
    const fileSection = block.slice(newlineIdx + 1);

    const [sha, message, author, date] = headerLine.split(RS);

    // File paths: non-empty lines, filter to only those inside the service folder
    const filesChanged = fileSection
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.startsWith(servicePath));

    return { sha, message, author, date, filesChanged };
  });
}

/**
 * Treat every commit touching services/<service>/ as a simulated deploy.
 * Returns entries sorted newest-first.
 *
 * Each entry has the shape from the contract:
 *   { timestamp, commitSha, description }
 *
 * @param {object} params
 * @param {string}  params.service   - service name, e.g. "payment-service"
 * @param {string} [params.repoPath] - override repo path (used by tests)
 * @returns {Array<{timestamp, commitSha, description}>}
 */
export function checkDeployHistory({ service, repoPath = INFRA_REPO }) {
  // Reuse getRecentCommits (no `since` filter, newest first via git's default)
  const commits = getRecentCommits({ service, repoPath });

  return commits.map(({ sha, message, date }) => ({
    timestamp: date,
    commitSha: sha,
    description: message,
  }));
}
