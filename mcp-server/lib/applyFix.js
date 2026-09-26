/**
 * applyFix - apply a remediation action to a service.
 *
 * Supported actions:
 *
 *   "revert"        - git revert <commitSha> (no force-push, normal revert commit)
 *                     scoped via pathspec to services/<service>/
 *
 *   "config_change" - details: { envVar, newValue }
 *                     Updates INFRA_REPO/.env then runs:
 *                       docker rm -f <service>
 *                       docker compose up -d <service>
 *                     to recreate just that container with the new env.
 *                     Only envVars on the explicit allowlist are accepted.
 *
 * Returns { status: "success"|"error", message: string } - never throws.
 * Every invocation is appended to mcp-server/apply_fix_audit.log.
 *
 * Safety constraints enforced here (not just in the MCP schema):
 *  - action must be exactly "revert" or "config_change"
 *  - envVar must be on ENV_VAR_ALLOWLIST
 *  - commitSha must look like a valid hex SHA (prevents shell injection)
 *  - execFileSync is used throughout (no shell: true, no string interpolation)
 */

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Paths - reuse the same env var as the other infra tools
// ---------------------------------------------------------------------------
const INFRA_REPO =
  process.env.INFRA_REPO_PATH ??
  resolve(__dirname, "../../../../cloudops-sample-infra");

const ENV_FILE = resolve(INFRA_REPO, ".env");

// Audit log lives in mcp-server/ (one level up from lib/)
const AUDIT_LOG = resolve(__dirname, "../apply_fix_audit.log");

// ---------------------------------------------------------------------------
// Safety allowlists
// ---------------------------------------------------------------------------
const ALLOWED_ACTIONS = ["revert", "config_change"];

/**
 * Only env vars explicitly listed here can be changed via config_change.
 * Add new vars here only after team review.
 */
const ENV_VAR_ALLOWLIST = new Set(["DOWNSTREAM_TIMEOUT_MS"]);

/** Basic hex SHA validation - 7 to 40 hex chars. */
function isValidSha(sha) {
  return /^[0-9a-f]{7,40}$/i.test(sha);
}

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------
function audit(entry) {
  const line =
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  try {
    appendFileSync(AUDIT_LOG, line, "utf8");
  } catch {
    // Audit log failure must not mask the real result
  }
}

// ---------------------------------------------------------------------------
// .env file helpers
// ---------------------------------------------------------------------------

/**
 * Read the .env file as an array of raw lines for round-trip preservation.
 */
function readEnvLines(filePath) {
  return existsSync(filePath)
    ? readFileSync(filePath, "utf8").split("\n")
    : [];
}

/**
 * Set (or add) a key=value in the .env file, preserving all other lines.
 * Returns the previous value (or undefined if the key didn't exist).
 */
function setEnvVar(filePath, key, value) {
  const lines = readEnvLines(filePath);
  let found = false;
  let previousValue;

  const updated = lines.map((line) => {
    const match = line.match(/^([^#=\s]+)=(.*)$/);
    if (match && match[1] === key) {
      previousValue = match[2];
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    updated.push(`${key}=${value}`);
  }

  writeFileSync(filePath, updated.join("\n"), "utf8");
  return previousValue;
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

/**
 * "revert" action - create a revert commit for <commitSha>.
 *
 * We use --no-commit first, then commit manually with a message that records
 * both the service and the original SHA.
 * The pathspec limits the revert to the service's folder only.
 */
function doRevert({ service, commitSha, infraRepo = INFRA_REPO }) {
  const servicePath = `services/${service}/`;

  // Validate SHA before passing it to git
  if (!isValidSha(commitSha)) {
    return {
      status: "error",
      message: `Invalid commitSha "${commitSha}" - must be 7-40 hex characters.`,
    };
  }

  try {
    // Stage the revert without committing so we can inspect it first
    execFileSync(
      "git",
      ["-C", infraRepo, "revert", "--no-commit", commitSha],
      { encoding: "utf8", stdio: "pipe" }
    );

    // Commit the revert with an informative message
    const revertMessage = `revert(${service}): revert ${commitSha.slice(0, 12)} via apply_fix`;
    execFileSync(
      "git",
      ["-C", infraRepo, "commit", "-m", revertMessage, "--", servicePath],
      { encoding: "utf8", stdio: "pipe" }
    );

    return {
      status: "success",
      message:
        `Reverted commit ${commitSha} for service "${service}". ` +
        `A new revert commit has been created in ${infraRepo}. ` +
        `No force-push was performed - history is preserved.`,
    };
  } catch (err) {
    // If the revert staged but commit failed, reset to a clean state
    try {
      execFileSync("git", ["-C", infraRepo, "revert", "--abort"], {
        stdio: "pipe",
      });
    } catch {
      // ignore - revert may not have started
    }
    return {
      status: "error",
      message: `git revert failed for commit ${commitSha}: ${err.stderr ?? err.message}`,
    };
  }
}

/**
 * "config_change" action - update an env var and restart the container.
 */
function doConfigChange({ service, details, envFile = ENV_FILE, infraRepo = INFRA_REPO }) {
  const { envVar, newValue } = details ?? {};

  if (!envVar) {
    return { status: "error", message: 'details.envVar is required for action "config_change".' };
  }
  if (newValue === undefined || newValue === null) {
    return { status: "error", message: 'details.newValue is required for action "config_change".' };
  }
  if (!ENV_VAR_ALLOWLIST.has(envVar)) {
    const allowed = [...ENV_VAR_ALLOWLIST].join(", ");
    return {
      status: "error",
      message:
        `"${envVar}" is not on the env var allowlist. ` +
        `Allowed vars: ${allowed}.`,
    };
  }

  // Write the new value to .env (use the passed-in envFile, not module-level constant)
  const previousValue = setEnvVar(envFile, envVar, String(newValue));

  // Remove any stopped container with the same name first.
  // docker compose up will not overwrite a stopped container by name and
  // will error with "name already in use" if one exists.
  try {
    execFileSync("docker", ["rm", "-f", service], { stdio: "pipe" });
  } catch {
    // Container may not exist yet; that is fine.
  }

  // Start just this service from the compose file (no full stack rebuild).
  try {
    execFileSync(
      "docker",
      ["compose", "up", "-d", service],
      { cwd: infraRepo, encoding: "utf8", stdio: "pipe" }
    );
  } catch (err) {
    // .env was already written; report the docker failure clearly
    return {
      status: "error",
      message:
        `${envVar} was updated to "${newValue}" in ${envFile} ` +
        `(previous: "${previousValue ?? "not set"}"), ` +
        `but "docker compose up -d ${service}" failed: ${err.stderr ?? err.message}. ` +
        `The .env change is persisted - you may need to restart the container manually.`,
    };
  }

  return {
    status: "success",
    message:
      `${envVar} changed from "${previousValue ?? "not set"}" to "${newValue}" in ${envFile}. ` +
      `Container "${service}" recreated via "docker rm -f && docker compose up -d ${service}".`,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {string}  params.service    - service name
 * @param {string}  params.commitSha  - target commit SHA (required even for config_change, for audit)
 * @param {string}  params.action     - "revert" | "config_change"
 * @param {object} [params.details]   - { envVar, newValue } for config_change
 * @param {string} [params.infraRepo] - override infra repo path (used by tests)
 * @returns {{ status: "success"|"error", message: string }}
 */
export function applyFix({ service, commitSha, action, details, infraRepo } = {}) {
  // Allow test override of the infra repo path
  const repoPath = infraRepo ?? INFRA_REPO;

  // Derive envFile from repoPath so test overrides work correctly
  const envFile = resolve(repoPath, ".env");

  const request = { service, commitSha, action, details };

  // Safety gate: action allowlist
  if (!ALLOWED_ACTIONS.includes(action)) {
    const result = {
      status: "error",
      message: `Unknown action "${action}". Allowed: ${ALLOWED_ACTIONS.join(", ")}.`,
    };
    audit({ request, result });
    return result;
  }

  let result;

  if (action === "revert") {
    result = doRevert({ service, commitSha, infraRepo: repoPath });
  } else {
    result = doConfigChange({ service, details, envFile, infraRepo: repoPath });
  }

  audit({ request, result });
  return result;
}
