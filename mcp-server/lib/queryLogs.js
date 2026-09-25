/**
 * queryLogs — read structured log entries from the shared SQLite database.
 *
 * The SQLite file is written by all four sample-infra containers to
 * /logs/shared-logs.db inside Docker.  The docker-compose.yml bind-mounts
 * that path to cloudops-sample-infra/logs/shared-logs.db on the host, which
 * is what we read here.
 *
 * Schema (from services/<service>/logger.js):
 *   logs(id, timestamp TEXT, service TEXT, level TEXT,
 *        trace_id TEXT, message TEXT, meta TEXT)
 *   meta is a JSON string or NULL.
 */

import Database from "better-sqlite3";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Path from mcp-server/lib/ up 4 levels to cloudops-sample-infra/logs/shared-logs.db
// Structure: cloudops-rca-new/cloudops-rca/mcp-server/lib/ → ../../../../cloudops-sample-infra/
const DEFAULT_DB_PATH = resolve(
  __dirname,
  "../../../../cloudops-sample-infra/logs/shared-logs.db"
);

/**
 * @param {object} params
 * @param {string}  params.service    - required; filters rows by service column
 * @param {string} [params.start_time] - ISO-8601; inclusive lower bound on timestamp
 * @param {string} [params.end_time]   - ISO-8601; inclusive upper bound on timestamp
 * @param {string} [params.trace_id]   - exact match on trace_id column
 * @param {string} [params.dbPath]     - override DB path (used by tests)
 * @returns {Array<{timestamp,service,level,trace_id,message,meta}>}
 */
export function queryLogs({
  service,
  start_time,
  end_time,
  trace_id,
  dbPath = DEFAULT_DB_PATH,
}) {
  // If the DB doesn't exist yet (containers not started), return empty array.
  if (!existsSync(dbPath)) {
    return [];
  }

  // Open read-only so we never accidentally corrupt the live database.
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const conditions = ["service = ?"];
    const bindings = [service];

    if (start_time) {
      conditions.push("timestamp >= ?");
      bindings.push(start_time);
    }
    if (end_time) {
      conditions.push("timestamp <= ?");
      bindings.push(end_time);
    }
    if (trace_id) {
      conditions.push("trace_id = ?");
      bindings.push(trace_id);
    }

    const sql = `
      SELECT timestamp, service, level, trace_id, message, meta
      FROM logs
      WHERE ${conditions.join(" AND ")}
      ORDER BY timestamp ASC
    `;

    const rows = db.prepare(sql).all(...bindings);

    // Parse the JSON meta column into an object (or null if absent).
    return rows.map((row) => ({
      ...row,
      meta: row.meta ? JSON.parse(row.meta) : null,
    }));
  } finally {
    db.close();
  }
}
