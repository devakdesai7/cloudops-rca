# cloudops-rca MCP Server

Node.js MCP server that exposes the five tools defined in
[`docs/shared_contract.md`](../docs/shared_contract.md) to IBM Bob.

The server communicates over **stdio** — Bob (or any MCP client) spawns it as a
child process and exchanges JSON-RPC messages through stdin/stdout.

## Prerequisites

- Node.js ≥ 18

## Install dependencies

```bash
cd mcp-server
npm install
```

## Running under Bob

Bob discovers and spawns this server automatically via the workspace MCP config at
`.bob/mcp.json`.  Once the workspace is open in Bob, the server appears in the MCP
panel and the five tools are available to all workflows.

No manual start is needed for normal use.

## Manual / standalone testing

You can launch the server directly to verify it starts without errors or to inspect
its MCP handshake:

```bash
node mcp-server/index.js
```

Startup logs go to **stderr** (not stdout) — you should see:

```
cloudops-rca-tools MCP server running on stdio
```

The server then waits for JSON-RPC input on stdin.  To exercise a tool, you can
pipe a valid `tools/call` request.  For a quick smoke-test you only need to confirm
the process starts and the line above appears.

Press `Ctrl+C` to stop.

## Exposed tools

| Tool | Signature | Returns |
|---|---|---|
| `query_logs` | `(service, start_time?, end_time?, trace_id?)` | `[{ timestamp, service, level, trace_id, message, meta }]` |
| `get_recent_commits` | `(service, since?)` | `[{ sha, message, author, date, filesChanged }]` |
| `get_runbook` | `(service)` | `string` (Markdown) |
| `check_deploy_history` | `(service)` | `[{ timestamp, commitSha, description }]` |
| `apply_fix` | `(service, commitSha, action, details?)` | `{ status, message }` |

All tools currently return **placeholder responses** with `TODO` comments in their
handler bodies.  Real implementation is the next task.

## Optional debug HTTP port

Port **4100** is reserved in the shared contract for manual HTTP testing of this
server.  The current implementation uses only stdio; if you later add an HTTP
transport for testing purposes, listen on 4100.

## Folder ownership

```
cloudops-rca/
├── docs/          ← shared contract (source of truth)
├── mcp-server/    ← this package (your responsibility)
├── backend/       ← Shivang
├── frontend/      ← Divy
└── .bob/          ← shared config; mcp.json lives here
```
