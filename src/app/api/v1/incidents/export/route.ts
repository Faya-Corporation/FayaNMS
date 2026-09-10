import { db } from "@/lib/db";
import { fail, newCorrelationId } from "../../_lib/api";
import { computeSlaState, formatSlaCountdown } from "@/lib/incidents/lifecycle";
import { FAYANMS_BRAND } from "@/lib/brand/identity";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/incidents/export?id=… — Post-Incident Review report export
 * (Task 5-b). Returns a self-contained printable HTML document
 * (Content-Type text/html; Content-Disposition inline;
 * filename INC-<number>-PIR.html) so the browser can Print → PDF without
 * any server-side PDF dependency. Sections: header with severity/status/SLA
 * outcome (breached flag + actual resolve duration vs target), timeline
 * table (kind + actor + time), affected devices, linked change + alerts,
 * RCA/PIR (root cause / corrective / preventive) and sign-off lines.
 */

function esc(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function duration(from: Date, to: Date): string {
  const ms = Math.max(0, to.getTime() - from.getTime());
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return `${hours} h ${rest} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id")?.trim() ?? "";
  if (!id || id.length > 64) {
    return fail("INVALID_QUERY", "Query parameter id is required", 400);
  }

  const incident = await db.incident.findUnique({
    where: { id },
    include: {
      site: { select: { name: true, code: true } },
      owner: { select: { name: true, email: true } },
      change: {
        select: { number: true, title: true, status: true, riskLevel: true },
      },
      devices: {
        select: {
          device: { select: { hostname: true, status: true, model: true } },
        },
      },
      events: {
        orderBy: { createdAt: "asc" },
        select: {
          kind: true,
          message: true,
          createdAt: true,
          actor: { select: { name: true, email: true } },
        },
      },
      alerts: {
        orderBy: { lastSeen: "desc" },
        select: {
          severity: true,
          message: true,
          status: true,
          count: true,
          firstSeen: true,
          lastSeen: true,
          device: { select: { hostname: true } },
        },
      },
    },
  });

  if (!incident) {
    return fail("INCIDENT_NOT_FOUND", "Incident not found", 404);
  }

  const sla = computeSlaState({
    severity: incident.severity,
    status: incident.status,
    createdAt: incident.createdAt,
    slaDueAt: incident.slaDueAt,
    resolvedAt: incident.resolvedAt,
  });

  const slaOutcome = sla.outcome
    ? sla.outcome === "MET"
      ? `MET (resolved within the ${sla.targetLabel ?? "SLA"} target)`
      : `BREACHED (exceeded the ${sla.targetLabel ?? "SLA"} target)`
    : sla.breached
      ? `BREACHED — overdue by ${formatSlaCountdown(sla.dueInMs ?? 0)}`
      : `IN PROGRESS — ${formatSlaCountdown(sla.dueInMs ?? 0)} remaining (${sla.remainingPct ?? 0}% of window)`;

  const timeToAck = incident.acknowledgedAt
    ? duration(incident.createdAt, incident.acknowledgedAt)
    : "not acknowledged";
  const timeToResolve = incident.resolvedAt
    ? duration(incident.createdAt, incident.resolvedAt)
    : "not resolved yet";

  const timelineRows = incident.events
    .map(
      (event) => `
      <tr>
        <td class="mono">${fmt(event.createdAt)}</td>
        <td><span class="kind kind-${esc(event.kind.toLowerCase())}">${esc(event.kind)}</span></td>
        <td>${esc(event.actor?.name ?? (event.kind === "SYSTEM" ? "system" : "—"))}</td>
        <td>${esc(event.message)}</td>
      </tr>`
    )
    .join("");

  const deviceRows = incident.devices
    .map(
      (link) => `
      <tr>
        <td class="mono">${esc(link.device.hostname)}</td>
        <td>${esc(link.device.model ?? "—")}</td>
        <td>${esc(link.device.status)}</td>
      </tr>`
    )
    .join("");

  const alertRows = incident.alerts
    .map(
      (alert) => `
      <tr>
        <td>${esc(alert.device?.hostname ?? "—")}</td>
        <td>${esc(alert.severity)}</td>
        <td>${esc(alert.status)}</td>
        <td>${alert.count}</td>
        <td class="mono">${fmt(alert.firstSeen)}</td>
        <td>${esc(alert.message)}</td>
      </tr>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(incident.number)} — Post-Incident Review</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #171717; margin: 0; padding: 32px; background: #fff; font-size: 13px; line-height: 1.55; }
  .page { max-width: 900px; margin: 0 auto; }
  header.doc { border-bottom: 3px solid ${FAYANMS_BRAND.colors.primary}; padding-bottom: 12px; margin-bottom: 20px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .doc .sub { color: #525252; font-size: 12px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
       color: #525252; border-bottom: 1px solid #e5e5e5; padding-bottom: 4px; margin: 24px 0 8px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th, td { border: 1px solid #e5e5e5; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #fafafa; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #525252; }
  .mono { font-family: "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
  .kv { display: grid; grid-template-columns: 180px 1fr; gap: 4px 16px; }
  .kv dt { color: #525252; }
  .kv dd { margin: 0; }
  .pill { display: inline-block; border: 1px solid #d4d4d4; border-radius: 999px;
          padding: 1px 10px; font-size: 11px; font-weight: 600; }
  .pill.SEV1, .pill.CRITICAL { background: #fef2f2; border-color: #ef4444; color: #b91c1c; }
  .pill.SEV2, .pill.HIGH { background: #fff7ed; border-color: #f97316; color: #c2410c; }
  .pill.SEV3, .pill.MEDIUM { background: #fffbeb; border-color: #f59e0b; color: #b45309; }
  .pill.SEV4, .pill.LOW, .pill.INFO { background: #f5f5f5; color: #525252; }
  .pill.met { background: #f0fdf4; border-color: #22c55e; color: #15803d; }
  .pill.breached { background: #fef2f2; border-color: #ef4444; color: #b91c1c; }
  .kind { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .06em;
          border-radius: 4px; padding: 1px 6px; }
  .kind-system { background: #f5f5f5; color: #525252; }
  .kind-user { background: #eff6ff; color: #1d4ed8; }
  .kind-integration { background: #ecfeff; color: #0e7490; }
  .pir-box { border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px 14px; margin: 6px 0 12px; white-space: pre-wrap; background: #fafafa; }
  .signoff { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 8px; }
  .signoff .line { border-bottom: 1px solid #525252; height: 34px; }
  .signoff .cap { color: #525252; font-size: 11px; margin-top: 3px; }
  footer.doc { margin-top: 28px; color: #737373; font-size: 11px; border-top: 1px solid #e5e5e5; padding-top: 8px; }
  @media print { body { padding: 12mm; } h2 { break-after: avoid; } table { break-inside: auto; } tr { break-inside: avoid; } }
</style>
</head>
<body>
<div class="page">
  <header class="doc">
    <h1>${esc(incident.number)} — Post-Incident Review</h1>
    <div class="sub">${esc(incident.title)} · generated ${fmt(new Date())} · FayaNMS</div>
  </header>

  <h2>Summary</h2>
  <dl class="kv">
    <dt>Severity / priority</dt><dd><span class="pill ${esc(incident.severity)}">${esc(incident.severity)}</span>${incident.priority ? ` <span class="pill">${esc(incident.priority)}</span>` : ""}</dd>
    <dt>Status</dt><dd>${esc(incident.status)}</dd>
    <dt>Source</dt><dd>${esc(incident.source)}</dd>
    <dt>Site</dt><dd>${esc(incident.site ? `${incident.site.name} (${incident.site.code})` : "—")}</dd>
    <dt>Owner</dt><dd>${esc(incident.owner?.name ?? "—")}${incident.ownerTeam ? ` · team ${esc(incident.ownerTeam)}` : ""}</dd>
    <dt>Created</dt><dd class="mono">${fmt(incident.createdAt)}</dd>
    <dt>Acknowledged</dt><dd class="mono">${fmt(incident.acknowledgedAt)} (${esc(timeToAck)})</dd>
    <dt>Resolved</dt><dd class="mono">${fmt(incident.resolvedAt)} (${esc(timeToResolve)})</dd>
    <dt>Closed</dt><dd class="mono">${fmt(incident.closedAt)}</dd>
    <dt>SLA outcome</dt><dd><span class="pill ${sla.breached ? "breached" : sla.outcome === "MET" ? "met" : ""}">${sla.breached ? "BREACHED" : sla.outcome === "MET" ? "MET" : "IN PROGRESS"}</span> ${esc(slaOutcome)}</dd>
  </dl>
  ${incident.description ? `<h2>Description</h2><div class="pir-box">${esc(incident.description)}</div>` : ""}

  <h2>Affected devices</h2>
  ${
    deviceRows
      ? `<table><thead><tr><th>Hostname</th><th>Model</th><th>Status</th></tr></thead><tbody>${deviceRows}</tbody></table>`
      : "<p>No devices linked.</p>"
  }

  <h2>Linked change</h2>
  ${
    incident.change
      ? `<table><tbody><tr><th>Number</th><td class="mono">${esc(incident.change.number)}</td></tr>
         <tr><th>Title</th><td>${esc(incident.change.title)}</td></tr>
         <tr><th>Status / risk</th><td>${esc(incident.change.status)} · ${esc(incident.change.riskLevel)}</td></tr></tbody></table>`
      : "<p>No change correlated to this incident.</p>"
  }

  <h2>Related alerts</h2>
  ${
    alertRows
      ? `<table><thead><tr><th>Device</th><th>Severity</th><th>Status</th><th>Count</th><th>First seen</th><th>Message</th></tr></thead><tbody>${alertRows}</tbody></table>`
      : "<p>No alerts linked.</p>"
  }

  <h2>Timeline</h2>
  <table>
    <thead><tr><th>Time</th><th>Kind</th><th>Actor</th><th>Event</th></tr></thead>
    <tbody>${timelineRows}</tbody>
  </table>

  <h2>Root cause analysis</h2>
  <div class="pir-box">${esc(incident.rootCause) || "<em>Not recorded yet.</em>"}</div>

  <h2>Corrective action</h2>
  <div class="pir-box">${esc(incident.correctiveAction) || "<em>Not recorded yet.</em>"}</div>

  <h2>Preventive action</h2>
  <div class="pir-box">${esc(incident.preventiveAction) || "<em>Not recorded yet.</em>"}</div>

  <h2>Sign-off</h2>
  <div class="signoff">
    <div><div class="line"></div><div class="cap">Incident owner — ${esc(incident.owner?.name ?? "—")}${incident.owner?.email ? ` · ${esc(incident.owner.email)}` : ""}</div></div>
    <div><div class="line"></div><div class="cap">Service manager / CAB</div></div>
  </div>

  <footer class="doc">
    Generated by FayaNMS — printable report. Use your browser's Print (Ctrl/Cmd+P) to save as PDF.
  </footer>
</div>
</body>
</html>`;

  // Audit the export like other sensitive exports (3-a CONFIG_DOWNLOAD).
  try {
    await db.auditEvent.create({
      data: {
        actorName: "system:report-engine",
        action: "INCIDENT_PIR_EXPORTED",
        resourceType: "Incident",
        resourceId: incident.id,
        resourceLabel: `${incident.number} — PIR report`,
        result: "SUCCESS",
        correlationId: newCorrelationId("EXP"),
        afterJson: JSON.stringify({ number: incident.number, status: incident.status }),
      },
    });
  } catch (error) {
    console.error("[incidents/export] audit failed", error);
  }

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `inline; filename="${incident.number}-PIR.html"`,
      "Cache-Control": "no-store",
    },
  });
}
