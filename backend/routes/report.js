// backend/routes/report.js
// GET /api/incidents/:id/report
//
// Contract (shared_contract.md):
//   Response: text/markdown body
//
// Generates a markdown incident report on the fly from the DB.
// No external template files — everything is assembled here from:
//   incidents row (summary, status, times, hypothesis, proposedFix)
//   incident_services rows (per-service verdicts)
//   approvals + users join (who actioned, when)

'use strict';

const express = require('express');
const pool = require('../db/pool');

const router = express.Router({ mergeParams: true });

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d) {
  if (!d) return 'N/A';
  return new Date(d).toUTCString();
}

function fmtMs(ms) {
  if (ms == null) return 'N/A';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s (${ms} ms)`;
}

function statusBadge(status) {
  const map = {
    investigating:       '🔍 Investigating',
    awaiting_approval:   '⏳ Awaiting Approval',
    resolved:            '✅ Resolved',
    rejected:            '❌ Rejected',
    investigation_failed: '💥 Investigation Failed',
  };
  return map[status] ?? status;
}

function serviceVerdictIcon(verdict) {
  if (!verdict) return '⬜';
  const v = verdict.toLowerCase();
  if (v.includes('confirmed_anomaly')) return '🔴';
  if (v.includes('suspicious'))        return '🟡';
  if (v.includes('healthy'))           return '🟢';
  return '⬜';
}

// ── GET /api/incidents/:id/report ─────────────────────────────────────────────

router.get('/', async (req, res) => {
  const { id: incidentId } = req.params;

  // ── Fetch all data in parallel ─────────────────────────────────────────
  let inc, services, approvalRow;
  try {
    const [iRes, sRes, aRes] = await Promise.all([
      pool.query(
        `SELECT id, summary, affected_endpoint, status,
                hypothesis_json, proposed_fix_json, tool_calls_json,
                created_at, resolved_at, time_to_resolution_ms
         FROM incidents WHERE id = $1`,
        [incidentId]
      ),
      pool.query(
        `SELECT service, status, verdict, evidence_json
         FROM incident_services
         WHERE incident_id = $1
         ORDER BY id ASC`,
        [incidentId]
      ),
      pool.query(
        `SELECT a.action, a.created_at AS actioned_at, u.name AS actioned_by
         FROM approvals a
         JOIN users u ON u.id = a.user_id
         WHERE a.incident_id = $1
         ORDER BY a.created_at DESC
         LIMIT 1`,
        [incidentId]
      ),
    ]);

    if (iRes.rows.length === 0) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    inc         = iRes.rows[0];
    services    = sRes.rows;
    approvalRow = aRes.rows[0] ?? null;
  } catch (err) {
    console.error(`[report:${incidentId}] DB error:`, err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  const hypothesis  = inc.hypothesis_json   ?? null;
  const proposedFix = inc.proposed_fix_json ?? null;

  // ── Build markdown ─────────────────────────────────────────────────────
  const lines = [];

  lines.push(`# Incident Report: ${inc.summary}`);
  lines.push('');
  lines.push(`**Incident ID:** \`${inc.id}\``);
  lines.push(`**Status:** ${statusBadge(inc.status)}`);
  lines.push(`**Created:** ${fmtDate(inc.created_at)}`);
  if (inc.affected_endpoint) {
    lines.push(`**Affected Endpoint:** \`${inc.affected_endpoint}\``);
  }
  if (inc.resolved_at) {
    lines.push(`**Resolved:** ${fmtDate(inc.resolved_at)}`);
  }
  if (inc.time_to_resolution_ms != null) {
    lines.push(`**Time to Resolution:** ${fmtMs(inc.time_to_resolution_ms)}`);
  }
  lines.push('');

  // ── Service Investigation Summary ──────────────────────────────────────
  lines.push('## Service Investigation');
  lines.push('');
  if (services.length === 0) {
    lines.push('_No service investigation data recorded._');
  } else {
    lines.push('| Service | Status | Verdict |');
    lines.push('|---------|--------|---------|');
    for (const s of services) {
      const icon = serviceVerdictIcon(s.verdict);
      const verdict = s.verdict ? `${icon} ${s.verdict}` : `${icon} —`;
      lines.push(`| \`${s.service}\` | ${s.status} | ${verdict} |`);
    }
  }
  lines.push('');

  // ── Root Cause Hypothesis ──────────────────────────────────────────────
  lines.push('## Root Cause Hypothesis');
  lines.push('');
  if (!hypothesis) {
    lines.push('_No hypothesis was generated._');
  } else {
    lines.push(`**Root Cause Service:** \`${hypothesis.rootCauseService ?? 'unknown'}\``);
    lines.push('');
    lines.push(`**Explanation:** ${hypothesis.explanation ?? '—'}`);
    lines.push('');
    if (typeof hypothesis.confidence === 'number') {
      const pct = (hypothesis.confidence * 100).toFixed(0);
      lines.push(`**Confidence:** ${pct}%`);
      lines.push('');
    }
    if (Array.isArray(hypothesis.evidenceRefs) && hypothesis.evidenceRefs.length > 0) {
      lines.push('**Evidence References:**');
      lines.push('');
      for (const ref of hypothesis.evidenceRefs) {
        lines.push(`- ${ref}`);
      }
      lines.push('');
    }
  }

  // ── Proposed Fix ───────────────────────────────────────────────────────
  lines.push('## Proposed Fix');
  lines.push('');
  if (!proposedFix) {
    lines.push('_No fix was proposed._');
  } else {
    lines.push(`**Service:** \`${proposedFix.service ?? '—'}\``);
    lines.push(`**Action:** ${proposedFix.action ?? '—'}`);
    lines.push('');
    if (proposedFix.description) {
      lines.push(`**Description:** ${proposedFix.description}`);
      lines.push('');
    }
    if (proposedFix.diff) {
      lines.push('**Diff:**');
      lines.push('');
      lines.push('```diff');
      lines.push(proposedFix.diff);
      lines.push('```');
      lines.push('');
    }
  }

  // ── Approval ───────────────────────────────────────────────────────────
  lines.push('## Approval');
  lines.push('');
  if (!approvalRow) {
    lines.push('_No approval action recorded._');
  } else {
    const actionLabel = approvalRow.action === 'approve' ? '✅ Approved' : '❌ Rejected';
    lines.push(`**Decision:** ${actionLabel}`);
    lines.push(`**By:** ${approvalRow.actioned_by ?? 'unknown'}`);
    lines.push(`**At:** ${fmtDate(approvalRow.actioned_at)}`);
  }
  lines.push('');

  // ── Timeline ───────────────────────────────────────────────────────────
  lines.push('## Timeline');
  lines.push('');
  lines.push(`| Event | Time |`);
  lines.push(`|-------|------|`);
  lines.push(`| Incident triggered | ${fmtDate(inc.created_at)} |`);

  // Service done timestamps aren't stored individually, so we list the ones
  // that completed investigation (verdict not null) as a group.
  const doneServices = services.filter(s => s.status === 'done' && s.verdict);
  if (doneServices.length > 0) {
    lines.push(`| Service investigations complete (${doneServices.length} service${doneServices.length !== 1 ? 's' : ''}) | during triage |`);
  }
  if (hypothesis) {
    lines.push(`| Hypothesis generated | during triage |`);
  }
  if (approvalRow) {
    const actionLabel = approvalRow.action === 'approve' ? 'Fix approved' : 'Fix rejected';
    lines.push(`| ${actionLabel} by ${approvalRow.actioned_by ?? 'unknown'} | ${fmtDate(approvalRow.actioned_at)} |`);
  }
  if (inc.resolved_at) {
    lines.push(`| Incident resolved | ${fmtDate(inc.resolved_at)} |`);
  }
  lines.push('');

  // ── Tool Execution Audit Log ─────────────────────────────────────────────
  const toolCalls = inc.tool_calls_json || [];
  if (toolCalls.length > 0) {
    lines.push('## 🛠️ Tool Execution Audit Log');
    lines.push('');
    for (const tc of toolCalls) {
      lines.push(`### \`${tc.name}\``);
      if (tc.timestamp) {
        lines.push(`**Time:** ${fmtDate(tc.timestamp)}`);
        lines.push('');
      }
      lines.push('**Arguments:**');
      lines.push('```json');
      lines.push(JSON.stringify(tc.args, null, 2));
      lines.push('```');
      lines.push('');
    }
  }

  // ── Footer ─────────────────────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push(`_Report generated at ${fmtDate(new Date())} by CloudOps RCA._`);
  lines.push('');

  const markdown = lines.join('\n');

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(markdown);
});

module.exports = router;
