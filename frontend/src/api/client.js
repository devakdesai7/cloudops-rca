/**
 * API client for the CloudOps RCA backend.
 *
 * Base URL is read from the VITE_API_BASE env var (set in .env or .env.local).
 * Falls back to http://localhost:4000/api so the dev server works with no config.
 *
 * All helpers return the parsed JSON response body.
 * getReport() returns the raw text (the backend responds with text/markdown).
 * A non-2xx response throws an Error whose message is the response body string.
 *
 * The Authorization header is injected automatically when a token is present
 * in localStorage under the key "rca_token".
 */

const BASE_URL = import.meta.env.VITE_API_BASE ?? 'http://localhost:4000/api'

// ---------------------------------------------------------------------------
// Internal fetch wrapper
// ---------------------------------------------------------------------------

function getToken() {
  return localStorage.getItem('rca_token')
}

/**
 * @param {string} path   - path relative to BASE_URL, e.g. "/auth/login"
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
async function request(path, options = {}) {
  const token = getToken()

  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  })

  if (!response.ok) {
    // Try to read a descriptive error from the body; fall back to status text.
    let message
    try {
      const body = await response.text()
      message = body || response.statusText
    } catch {
      message = response.statusText
    }
    throw new Error(message)
  }

  return response
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/login
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ token: string, role: "approver"|"viewer", name: string }>}
 */
export async function login(email, password) {
  const res = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  return res.json()
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

/**
 * POST /api/incidents/trigger
 * @param {string} summary
 * @param {string} affectedEndpoint
 * @returns {Promise<{ incidentId: string, status: "triage_started" }>}
 */
export async function triggerIncident(summary, affectedEndpoint) {
  const res = await request('/incidents/trigger', {
    method: 'POST',
    body: JSON.stringify({ summary, affectedEndpoint }),
  })
  return res.json()
}

/**
 * GET /api/incidents
 * @returns {Promise<Array<{ incidentId: string, summary: string, status: string, createdAt: string }>>}
 */
export async function listIncidents() {
  const res = await request('/incidents')
  return res.json()
}

/**
 * GET /api/incidents/:id
 * @param {string} id
 * @returns {Promise<object>} Full incident object — see shared-contract.md for shape.
 */
export async function getIncident(id) {
  const res = await request(`/incidents/${id}`)
  return res.json()
}

/**
 * POST /api/incidents/:id/approve
 * @param {string} id
 * @param {"approve"|"reject"} action
 * @returns {Promise<{ status: "applied"|"rejected" }>}
 */
export async function approveIncident(id, action) {
  const res = await request(`/incidents/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  })
  return res.json()
}

/**
 * GET /api/incidents/:id/report
 * @param {string} id
 * @returns {Promise<string>} Markdown text of the incident report.
 */
export async function getReport(id) {
  const res = await request(`/incidents/${id}/report`)
  return res.text()
}

// ---------------------------------------------------------------------------
// Chaos (dev-only, approver role required)
// ---------------------------------------------------------------------------

/**
 * POST /api/chaos/inject
 * @param {string} service  e.g. "payment-service"
 * @param {number} timeoutMs
 * @returns {Promise<{ status: "injected" }>}
 */
export async function injectChaos(service, timeoutMs) {
  const res = await request('/chaos/inject', {
    method: 'POST',
    body: JSON.stringify({ service, timeoutMs }),
  })
  return res.json()
}

/**
 * POST /api/chaos/reset
 * @returns {Promise<{ status: "reset" }>}
 */
export async function resetChaos() {
  const res = await request('/chaos/reset', { method: 'POST' })
  return res.json()
}
