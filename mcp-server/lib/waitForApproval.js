/**
 * waitForApproval — block until a human approves or rejects the incident.
 *
 * Polls the backend's internal status endpoint every POLL_INTERVAL_MS until
 * the incident status transitions to 'approved' or 'rejected', then returns
 * the decision. Falls back to 'timeout' after MAX_WAIT_MS.
 *
 * Uses Node's native fetch (available in Node 18+) — no extra dependencies.
 *
 * The backend URL is derived from the PORT env var (default 4000), which is
 * inherited by the MCP server process since the backend spawns Bob with
 * { env: process.env }.
 */

const POLL_INTERVAL_MS = 5_000;   // Poll every 5 seconds
const MAX_WAIT_MS      = 600_000; // Give up after 10 minutes

/**
 * @param {object} params
 * @param {string} params.incidentId - UUID of the incident to watch
 * @returns {Promise<{ decision: "approved" | "rejected" | "timeout" }>}
 */
export async function waitForApproval({ incidentId }) {
  const port = process.env.PORT ?? '4000';
  const url  = `http://localhost:${port}/internal/incidents/${incidentId}/status`;

  const deadline = Date.now() + MAX_WAIT_MS;

  console.error(`[wait_for_approval] Polling ${url} every ${POLL_INTERVAL_MS / 1000}s (timeout ${MAX_WAIT_MS / 60000} min)`);

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);

      if (!res.ok) {
        console.error(`[wait_for_approval] HTTP ${res.status} from status endpoint — will retry`);
      } else {
        const body = await res.json();
        const status = body.status;

        console.error(`[wait_for_approval] Incident status: ${status}`);

        if (status === 'approved') {
          return { decision: 'approved' };
        }
        if (status === 'rejected') {
          return { decision: 'rejected' };
        }
        // Any other status (awaiting_approval, investigating, etc.) → keep polling
      }
    } catch (err) {
      // Network error (backend restarted, etc.) — log and keep trying
      console.error(`[wait_for_approval] fetch error: ${err.message} — will retry`);
    }

    // Wait POLL_INTERVAL_MS before the next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  console.error(`[wait_for_approval] Timed out after ${MAX_WAIT_MS / 60000} minutes`);
  return { decision: 'timeout' };
}
