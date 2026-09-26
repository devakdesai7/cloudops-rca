## 2. Shared Contract (identical across all three teammates — do not deviate)

> The first thing you build (or whoever gets there first) must commit this exact content as `cloudops-rca/docs/shared-contract.md`. All three of you will instruct Bob to **read this file** via document understanding rather than re-pasting it into prompts — keep it as the single source of truth.

### Ports
| Component | Port |
|---|---|
| sample-infra: api-gateway | 3000 |
| sample-infra: order-service | 3001 |
| sample-infra: payment-service | 3002 |
| sample-infra: inventory-service | 3003 |
| **backend (product)** | **4000** |
| **frontend dev server** | **5173** |
| mcp-server debug (optional, manual testing only) | 4100 |

### REST API base
`http://localhost:4000/api`

### Auth
JWT bearer token. Roles: `approver`, `viewer`.

```
POST /api/auth/login
Request:  { "email": string, "password": string }
Response: { "token": string, "role": "approver" | "viewer", "name": string }
```

### Incident endpoints
```
POST /api/incidents/trigger
Headers: Authorization: Bearer <token>
Request:  { "summary": string, "affectedEndpoint": string }
Response: { "incidentId": string, "status": "triage_started" }

GET /api/incidents
Response: [{ "incidentId": string, "summary": string, "status": string, "createdAt": string }]

GET /api/incidents/:id
Response: {
  "incidentId": string,
  "summary": string,
  "status": "investigating" | "awaiting_approval" | "resolved" | "rejected",
  "createdAt": string,
  "resolvedAt": string | null,
  "services": [
    { "service": string, "status": "queued"|"investigating"|"done", "verdict": string | null, "evidence": object | null }
  ],
  "hypothesis": {
    "rootCauseService": string,
    "explanation": string,
    "confidence": number,
    "evidenceRefs": [string]
  } | null,
  "proposedFix": {
    "service": string,
    "action": string,
    "description": string,
    "diff": string
  } | null,
  "approval": { "status": "pending"|"approved"|"rejected", "approvedBy": string|null, "approvedAt": string|null },
  "timeToResolutionMs": number | null
}

POST /api/incidents/:id/approve
Request:  { "action": "approve" | "reject" }
Response: { "status": "applied" | "rejected" }

GET /api/incidents/:id/report
Response: text/markdown body
```

### Chaos endpoints (dev-only, requires `approver` role)
```
POST /api/chaos/inject
Request:  { "service": "payment-service", "timeoutMs": number }
Response: { "status": "injected" }

POST /api/chaos/reset
Response: { "status": "reset" }
```

### WebSocket
`ws://localhost:4000/ws/incidents/:incidentId`

Server → client JSON messages:
```
{ "type": "subagent_update", "service": string, "status": "queued"|"investigating"|"done", "verdict": string|null }
{ "type": "hypothesis_ready", "hypothesis": { ...same shape as above... } }
{ "type": "awaiting_approval" }
{ "type": "fix_applied", "result": string }
{ "type": "incident_resolved", "timeToResolutionMs": number }
```

### Database schema (PostgreSQL, hosted on Neon — Shivang owns migrations, everyone must know the shape)
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  affected_endpoint TEXT,
  status TEXT NOT NULL,
  hypothesis_json JSONB,
  proposed_fix_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  time_to_resolution_ms INTEGER
);

CREATE TABLE incident_services (
  id SERIAL PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  service TEXT NOT NULL,
  status TEXT NOT NULL,
  verdict TEXT,
  evidence_json JSONB
);

CREATE TABLE approvals (
  id SERIAL PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Connection:** single shared Neon Postgres instance, remotely accessible from all three of your machines. The connection string is a shared secret — distributed via Slack/DM, never committed to git. Each of you puts it in your own local `backend/.env` as `DATABASE_URL=...`. Only Shivang's backend connects to this database directly — you never query it yourself.

### MCP Tool Contract (you own the implementation, Bob's workflow calls these)
```
query_logs(service: string, start_time?: string, end_time?: string, trace_id?: string)
  -> [{ timestamp, service, level, trace_id, message, meta }]

get_recent_commits(service: string, since?: string)
  -> [{ sha, message, author, date, filesChanged }]

get_runbook(service: string)
  -> string (markdown content)

check_deploy_history(service: string)
  -> [{ timestamp, commitSha, description }]

apply_fix(service: string, commitSha: string, action: "revert"|"config_change", details?: object)
  -> { status, message }
```

### Bob ↔ Backend process contract (critical — this is the seam between your work and Shivang's)
Shivang's backend spawns Bob as a child process per incident:
```
bob -p "<prompt referencing the incident>"
```
Your `triage-debug` workflow (Task 6) **must** instruct Bob to print progress as single-line, prefixed JSON to stdout, in addition to its normal reasoning output, so the backend can parse it regardless of Bob's natural language formatting:
```
BOB_EVENT:{"type":"subagent_update","service":"payment-service","status":"investigating"}
BOB_EVENT:{"type":"subagent_update","service":"payment-service","status":"done","verdict":"suspicious — deploy at 13:58 UTC reduced timeout"}
BOB_EVENT:{"type":"hypothesis_ready","hypothesis":{...}}
BOB_EVENT:{"type":"awaiting_approval"}
```
This is the exact event schema from the WebSocket section above — the backend just re-broadcasts these lines. **Do not change this schema without telling Shivang and Divy — both their layers depend on it exactly as written.**

### Folder ownership (zero overlap by design)
```
cloudops-rca/
├── docs/shared-contract.md   ← source of truth, commit first
├── mcp-server/                ← YOU
├── backend/                    ← Shivang
├── frontend/                    ← Divy
└── .bob/                          ← shared config; you own the workflow file inside it
```

### Filesystem layout (sibling repos)
mcp-server/ tools default to reading the sample infra as a sibling directory:
`../cloudops-sample-infra/` (relative to cloudops-rca/mcp-server/lib/).

If your local clone layout differs, override via environment variables in
`.bob/mcp.json`:
- `INFRA_REPO_PATH` — path to the cloudops-sample-infra repo root
- `LOG_DB_PATH` — path to shared-logs.db inside it

Both are optional — if unset, tools fall back to the default sibling-folder
path above. This env-var-with-fallback pattern must be used for every
MCP tool that reads from the sample infra (query_logs, get_recent_commits,
check_deploy_history, and later get_runbook, apply_fix) — build it in from
the start for new tools, don't retrofit later.
