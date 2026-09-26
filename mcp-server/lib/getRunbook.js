/**
 * getRunbook — read a service's on-call runbook from disk.
 *
 * Runbooks live at:
 *   cloudops-sample-infra/runbooks/<service>.md
 *
 * The infra repo path is read from the INFRA_REPO_PATH env var (same var
 * used by gitLog.js), falling back to the standard relative path.
 *
 * Returns the full Markdown string on success.
 * Returns a descriptive error string (never throws) when the file is absent,
 * so a calling subagent gets useful feedback rather than a crash.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Re-uses the same env var as gitLog.js — one override covers all infra tools.
const INFRA_REPO =
  process.env.INFRA_REPO_PATH ??
  resolve(__dirname, "../../../../cloudops-sample-infra");

const RUNBOOKS_DIR = resolve(INFRA_REPO, "runbooks");

/**
 * The resolved runbooks directory — exported so tests can assert the right
 * path is being used without duplicating the resolution logic.
 */
export { RUNBOOKS_DIR };

/**
 * @param {object} params
 * @param {string}  params.service      - service name, e.g. "payment-service"
 * @param {string} [params.runbooksDir] - override runbooks dir (used by tests)
 * @returns {string} Markdown content, or a descriptive error message string.
 */
export function getRunbook({ service, runbooksDir = RUNBOOKS_DIR }) {
  const filePath = resolve(runbooksDir, `${service}.md`);

  if (!existsSync(filePath)) {
    // Build a helpful message: list which runbooks *do* exist so the caller
    // (or a subagent) knows the valid service names immediately.
    let available = "(runbooks directory not found)";
    if (existsSync(runbooksDir)) {
      const files = readdirSync(runbooksDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, ""));
      available =
        files.length > 0
          ? files.join(", ")
          : "(no runbooks found in directory)";
    }
    return (
      `No runbook found for service "${service}". ` +
      `Available runbooks: ${available}.`
    );
  }

  return readFileSync(filePath, "utf8");
}
