#!/usr/bin/env node
/**
 * CloudOps RCA MCP Server
 *
 * Exposes the five tools defined in docs/shared-contract.md so that Bob can
 * call them during incident triage workflows.  Transport is stdio — the server
 * is spawned as a child process by Bob (or invoked manually for testing).
 *
 * Tool stubs return placeholder responses that match the documented return
 * shapes.  Real implementation goes in each handler body (marked TODO).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { queryLogs } from "./lib/queryLogs.js";

const server = new McpServer({
  name: "cloudops-rca-tools",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// query_logs
// Contract: query_logs(service, start_time?, end_time?, trace_id?)
//   -> [{ timestamp, service, level, trace_id, message, meta }]
// ---------------------------------------------------------------------------
server.registerTool(
  "query_logs",
  {
    description:
      "Fetch structured log entries for a given service, optionally filtered by time range and trace ID.",
    inputSchema: z.object({
      service: z.string().describe("Name of the service to query logs for"),
      start_time: z
        .string()
        .optional()
        .describe("ISO-8601 start of the time window"),
      end_time: z
        .string()
        .optional()
        .describe("ISO-8601 end of the time window"),
      trace_id: z
        .string()
        .optional()
        .describe("Filter to a specific distributed trace ID"),
    }),
  },
  async ({ service, start_time, end_time, trace_id }) => {
    const rows = queryLogs({ service, start_time, end_time, trace_id });
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// get_recent_commits
// Contract: get_recent_commits(service, since?)
//   -> [{ sha, message, author, date, filesChanged }]
// ---------------------------------------------------------------------------
server.registerTool(
  "get_recent_commits",
  {
    description:
      "Return recent Git commits for a service repository, optionally since a given date.",
    inputSchema: z.object({
      service: z.string().describe("Name of the service"),
      since: z
        .string()
        .optional()
        .describe("ISO-8601 date; return commits after this point"),
    }),
  },
  async ({ service, since }) => {
    // TODO: implement real git log query for the service's repository
    const placeholder = [
      {
        sha: "0000000000000000000000000000000000000000",
        message: "placeholder — real implementation pending",
        author: "unknown",
        date: new Date().toISOString(),
        filesChanged: [],
      },
    ];
    return {
      content: [{ type: "text", text: JSON.stringify(placeholder, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// get_runbook
// Contract: get_runbook(service)
//   -> string (markdown content)
// ---------------------------------------------------------------------------
server.registerTool(
  "get_runbook",
  {
    description:
      "Retrieve the on-call runbook for a service as a Markdown string.",
    inputSchema: z.object({
      service: z.string().describe("Name of the service"),
    }),
  },
  async ({ service }) => {
    // TODO: load runbook from disk or a knowledge base
    const placeholder = `# Runbook: ${service}\n\n> TODO: real runbook content pending.\n`;
    return {
      content: [{ type: "text", text: placeholder }],
    };
  }
);

// ---------------------------------------------------------------------------
// check_deploy_history
// Contract: check_deploy_history(service)
//   -> [{ timestamp, commitSha, description }]
// ---------------------------------------------------------------------------
server.registerTool(
  "check_deploy_history",
  {
    description: "List recent deployments for a service.",
    inputSchema: z.object({
      service: z.string().describe("Name of the service"),
    }),
  },
  async ({ service }) => {
    // TODO: query deployment records for the service
    const placeholder = [
      {
        timestamp: new Date().toISOString(),
        commitSha: "0000000000000000000000000000000000000000",
        description: `placeholder — real deploy history for ${service} pending`,
      },
    ];
    return {
      content: [{ type: "text", text: JSON.stringify(placeholder, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// apply_fix
// Contract: apply_fix(service, commitSha, action, details?)
//   -> { status, message }
// ---------------------------------------------------------------------------
server.registerTool(
  "apply_fix",
  {
    description:
      'Apply a remediation action to a service — either revert to a commit or push a config change. Requires approval before being called in production; action must be "revert" or "config_change".',
    inputSchema: z.object({
      service: z.string().describe("Name of the service to fix"),
      commitSha: z
        .string()
        .describe("Target commit SHA for the revert/reference"),
      action: z
        .enum(["revert", "config_change"])
        .describe("Type of remediation to apply"),
      details: z
        .record(z.unknown())
        .optional()
        .describe("Optional additional parameters for the action"),
    }),
  },
  async ({ service, commitSha, action, details }) => {
    // TODO: implement real fix application (git revert, config patch, etc.)
    const placeholder = {
      status: "pending",
      message: `placeholder — fix not applied. service=${service} commitSha=${commitSha} action=${action} details=${JSON.stringify(details ?? {})}`,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(placeholder, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // NOTE: use console.error for all logging — stdout is the MCP protocol channel.
  console.error("cloudops-rca-tools MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error starting MCP server:", error);
  process.exit(1);
});
