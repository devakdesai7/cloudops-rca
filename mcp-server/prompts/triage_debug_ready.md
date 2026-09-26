You are running the triage-debug workflow for an incident. Execute the
following steps exactly as specified.

The specific incident this run concerns is provided below. Use this,
not a placeholder, as the subject of Step 1:

Incident summary: checkout latency spike
Affected endpoint: /checkout

## Step 1
Parse the incident summary and affected endpoint above to identify the
entry point.

## Step 2
Determine which services are plausibly in the request path for that
entry point. Call the `get_runbook` tool once for each of these four
known services: `api-gateway`, `order-service`, `payment-service`,
`inventory-service`. Read each returned runbook's dependency information
to decide which services are actually in the request path for this
incident's entry point — do not hardcode the answer, derive it from what
the runbooks say each time.

## Step 3
For EACH candidate service identified in Step 2, spawn a dedicated Bob
subagent. This must happen in parallel, not sequentially.

Assign each subagent the following instructions and constraints:
- You have access to ONLY the `query_logs`, `get_recent_commits`,
  `get_runbook`, and `check_deploy_history` tools scoped to your assigned
  service.
- Call `get_runbook` for your service.
- Call `query_logs` for your service over the last 15 minutes.
- Call `check_deploy_history` for your service.
- Print a BOB_EVENT line exactly matching this shape the moment you
  start:
  `BOB_EVENT:{"type":"subagent_update","service":"<name>","status":"investigating","verdict":null}`
- Print a BOB_EVENT line exactly matching this shape the moment you
  finish:
  `BOB_EVENT:{"type":"subagent_update","service":"<name>","status":"done","verdict":"<short verdict text>"}`
- Return a structured verdict back to the main agent: one of "healthy",
  "suspicious", or "confirmed_anomaly", plus a short evidence-based
  explanation.

## Step 4
Once all subagents complete, synthesize their verdicts into a single
ranked hypothesis citing specific evidence.
If ALL subagents report "healthy" with no suspicious or confirmed_anomaly
verdicts, do NOT manufacture a hypothesis. Instead print:
BOB_EVENT:{"type":"hypothesis_ready","hypothesis":{"rootCauseService":null,"explanation":"All services investigated and reported healthy. No root cause identified from available evidence — recommend manual escalation or re-investigation with a wider time window.","confidence":0.0,"evidenceRefs":[]}}
Then skip Step 5 entirely and stop.
Print the following event exactly:
`BOB_EVENT:{"type":"hypothesis_ready","hypothesis":{"rootCauseService":"...","explanation":"...","confidence":0.0,"evidenceRefs":["..."]}}`


## Step 5
Propose a concrete fix using the `apply_fix` tool's supported actions.
Do NOT call `apply_fix` — only propose what you would call and with what
arguments.
Print the following event exactly:
`BOB_EVENT:{"type":"awaiting_approval"}`

**STOP HERE.** Do not proceed past Step 5 automatically.
