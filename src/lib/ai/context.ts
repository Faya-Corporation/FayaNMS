import { db } from "@/lib/db";
import { sessionAllowsSite, type SessionScopeClaims } from "@/lib/auth/scope";

/**
 * Compact operational-context builders for the AI endpoints (Phase 12-a).
 *
 * Everything the model sees is assembled SERVER-SIDE from FayaNMS records —
 * no credential material, no secrets, no config payloads ever leave the
 * platform. The text is deliberately terse (label: value lines) so the LLM
 * budget is spent on reasoning, not prose.
 *
 * The schema has no per-interface error-counter columns, so the "interface
 * error counters" brief is fulfilled with what the platform genuinely holds:
 * oper/admin status + last-flap timestamps, per-interface throughput
 * counters (bps) and the PACKET_LOSS metric series — the signals a NOC
 * engineer actually uses to spot erroring links.
 *
 * F-031 (wave 9, audit 9-b F-1): both builders accept the request's session
 * scope claims and fuse the row-level site predicate (sessionAllowsSite —
 * the EXACT predicate of the GET /api/v1/devices/[id] fused-404) into the
 * not-found branch, so an out-of-scope device/incident is indistinguishable
 * from a nonexistent one (no existence leak through the AI plane). The
 * claims parameter is OPTIONAL and defaults to undefined = wildcard, so
 * every pre-existing call keeps byte-identical behavior.
 */

/** Statuses counted as "open" for incidents feeding the AI context. */
const OPEN_INCIDENT_STATUSES = [
  "NEW",
  "ACKNOWLEDGED",
  "ASSIGNED",
  "INVESTIGATING",
  "MITIGATING",
  "MONITORING",
];

/** Context windows — kept small so prompts stay compact and cheap. */
const MAX_ALERTS = 10;
const MAX_AUDIT_EVENTS = 10;
const MAX_OPEN_INCIDENTS = 10;
const MAX_INTERFACES_LISTED = 12;
const MAX_TIMELINE_EVENTS = 60;
const MAX_INCIDENT_ALERTS = 15;
const MAX_METRICS_PER_KEY = 6;
const MAX_MESSAGE_CHARS = 220;

export interface AiContextSummary {
  alertsConsidered: number;
  eventsConsidered: number;
  incidentsConsidered: number;
}

export interface AiContext {
  /** Compact, model-facing context block (no secrets). */
  text: string;
  summary: AiContextSummary;
}

function clip(value: string | null | undefined, max = MAX_MESSAGE_CHARS): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function iso(date: Date | null | undefined): string {
  return date ? date.toISOString().replace(".000", "") : "n/a";
}

function uptimeText(seconds: bigint | null): string {
  if (seconds === null) return "n/a";
  const total = Number(seconds);
  if (!Number.isFinite(total)) return "n/a";
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  return `${total}s (~${days}d ${hours}h)`;
}

/* ------------------------------------------------------------------ */
/* Device scope                                                        */
/* ------------------------------------------------------------------ */

export async function buildDeviceContext(
  deviceId: string,
  scopeClaims?: SessionScopeClaims | null
): Promise<AiContext | null> {
  const device = await db.device.findUnique({
    where: { id: deviceId },
    include: {
      vendor: { select: { name: true, key: true, adapterKey: true } },
      site: { select: { name: true, code: true } },
    },
  });
  // Fused-404 (F-031 wave 9): !device OR out-of-scope site → the same null
  // the route already maps to its existing not-found envelope. Row-level
  // null-site parity: a device with no site is hidden from sites-limited
  // sessions exactly like scopedDeviceWhere hides it from lists (fail-closed
  // SQL parity — see siteScopeAllows in src/lib/auth/scope.ts).
  if (!device || !sessionAllowsSite(scopeClaims, device.site?.code ?? null)) {
    return null;
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [alerts, auditEvents, openIncidents, interfaces, recentMetrics] =
    await Promise.all([
      db.alert.findMany({
        where: { deviceId },
        orderBy: { lastSeen: "desc" },
        take: MAX_ALERTS,
        select: {
          severity: true,
          status: true,
          message: true,
          count: true,
          firstSeen: true,
          lastSeen: true,
        },
      }),
      db.auditEvent.findMany({
        // Same convention as GET /api/v1/devices/[id]/audit: Device records
        // (both casings seen in the wild) + device-backed ConfigSnapshot rows.
        where: { resourceId: deviceId, resourceType: { in: ["Device", "DEVICE", "ConfigSnapshot"] } },
        orderBy: { createdAt: "desc" },
        take: MAX_AUDIT_EVENTS,
        select: {
          action: true,
          result: true,
          actorName: true,
          resourceLabel: true,
          createdAt: true,
        },
      }),
      db.incident.findMany({
        where: { devices: { some: { deviceId } }, status: { in: OPEN_INCIDENT_STATUSES } },
        orderBy: { createdAt: "desc" },
        take: MAX_OPEN_INCIDENTS,
        select: { number: true, severity: true, status: true, title: true, createdAt: true },
      }),
      db.deviceInterface.findMany({
        where: { deviceId },
        orderBy: [{ operStatus: "asc" }, { name: "asc" }],
        select: {
          name: true,
          adminStatus: true,
          operStatus: true,
          speedMbps: true,
          countersInBps: true,
          countersOutBps: true,
          lastFlapAt: true,
        },
      }),
      db.metricSample.findMany({
        where: { deviceId, ts: { gte: since }, metric: { in: ["CPU", "MEMORY", "LATENCY_MS", "PACKET_LOSS"] } },
        orderBy: { ts: "desc" },
        take: MAX_METRICS_PER_KEY * 4,
        select: { metric: true, value: true, ts: true },
      }),
    ]);

  const lines: string[] = [];

  lines.push("DEVICE RECORD");
  lines.push(`- Hostname: ${device.hostname}${device.displayName ? ` (display: ${device.displayName})` : ""}`);
  lines.push(`- Management IP: ${device.mgmtIp}`);
  lines.push(
    `- Vendor/model: ${device.vendor.name} (${device.vendor.key}, adapter ${device.vendor.adapterKey})` +
      `${device.model ? ` / ${device.model}` : ""}${device.platform ? ` platform ${device.platform}` : ""}`
  );
  if (device.firmware) lines.push(`- Firmware: ${device.firmware}`);
  if (device.serialNumber) lines.push(`- Serial: ${device.serialNumber}`);
  if (device.role) lines.push(`- Role: ${device.role}`);
  if (device.site) lines.push(`- Site: ${device.site.name} (${device.site.code})`);
  lines.push(
    `- Status: ${device.status} | Criticality: ${device.criticality} | Health score: ${device.healthScore}/100`
  );
  lines.push(
    `- Backup compliance: ${device.backupCompliance} | Last backup: ${iso(device.lastBackupAt)}` +
      ` | Last config change: ${iso(device.lastConfigChangeAt)} | Last seen: ${iso(device.lastSeen)}`
  );
  lines.push(`- Uptime: ${uptimeText(device.uptimeSeconds)}`);

  lines.push(`RECENT ALERTS (last ${alerts.length}, newest first)`);
  if (alerts.length === 0) lines.push("- (none recorded)");
  for (const alert of alerts) {
    lines.push(
      `- [${alert.severity}/${alert.status}] x${alert.count} first ${iso(alert.firstSeen)} last ${iso(alert.lastSeen)} — ${clip(alert.message)}`
    );
  }

  lines.push(`OPEN INCIDENTS (${openIncidents.length})`);
  if (openIncidents.length === 0) lines.push("- (none open)");
  for (const incident of openIncidents) {
    lines.push(
      `- ${incident.number} [${incident.severity}/${incident.status}] opened ${iso(incident.createdAt)} — ${clip(incident.title, 140)}`
    );
  }

  lines.push(`AUDIT TRAIL FOR THIS DEVICE (last ${auditEvents.length}, newest first)`);
  if (auditEvents.length === 0) lines.push("- (no audit events)");
  for (const event of auditEvents) {
    lines.push(
      `- ${iso(event.createdAt)} ${event.action} (${event.result}) by ${event.actorName}` +
        `${event.resourceLabel ? ` — ${clip(event.resourceLabel, 120)}` : ""}`
    );
  }

  const down = interfaces.filter((iface) => iface.operStatus !== "UP");
  const up = interfaces.filter((iface) => iface.operStatus === "UP");
  lines.push(
    `INTERFACES (${interfaces.length} total, ${up.length} oper-up, ${down.length} not-up)`
  );
  if (interfaces.length === 0) lines.push("- (no interfaces recorded)");
  // Not-up interfaces first (diagnostically interesting), then top up-links.
  for (const iface of [...down, ...up].slice(0, MAX_INTERFACES_LISTED)) {
    const speed = iface.speedMbps ? ` ${iface.speedMbps}Mbps` : "";
    const inBps = iface.countersInBps !== null ? ` in ${Number(iface.countersInBps)}bps` : "";
    const outBps = iface.countersOutBps !== null ? ` out ${Number(iface.countersOutBps)}bps` : "";
    const flap = iface.lastFlapAt ? ` last-flap ${iso(iface.lastFlapAt)}` : "";
    lines.push(
      `- ${iface.name}: admin ${iface.adminStatus} / oper ${iface.operStatus},${speed}${inBps}${outBps}${flap}`
    );
  }
  if (interfaces.length > MAX_INTERFACES_LISTED) {
    lines.push(`- (…${interfaces.length - MAX_INTERFACES_LISTED} more interfaces omitted)`);
  }

  // Latest N samples per metric key (already ordered newest-first) → shows trend.
  const byMetric = new Map<string, { value: number; ts: Date }[]>();
  for (const sample of recentMetrics) {
    const bucket = byMetric.get(sample.metric) ?? [];
    if (bucket.length < MAX_METRICS_PER_KEY) {
      bucket.push({ value: sample.value, ts: sample.ts });
      byMetric.set(sample.metric, bucket);
    }
  }
  lines.push("METRIC SAMPLES (last 24h, newest first, value@time)");
  if (byMetric.size === 0) lines.push("- (no recent samples)");
  for (const [metric, samples] of byMetric) {
    lines.push(
      `- ${metric}: ${samples.map((s) => `${s.value}@${iso(s.ts)}`).join(", ")}`
    );
  }

  return {
    text: lines.join("\n"),
    summary: {
      alertsConsidered: alerts.length,
      eventsConsidered: auditEvents.length,
      incidentsConsidered: openIncidents.length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Incident scope                                                      */
/* ------------------------------------------------------------------ */

export async function buildIncidentContext(
  incidentId: string,
  scopeClaims?: SessionScopeClaims | null
): Promise<AiContext | null> {
  const incident = await db.incident.findUnique({
    where: { id: incidentId },
    include: {
      site: { select: { name: true, code: true } },
      owner: { select: { name: true, email: true } },
      change: { select: { number: true, title: true, status: true, riskLevel: true } },
      devices: {
        select: {
          device: {
            select: {
              hostname: true,
              status: true,
              model: true,
              mgmtIp: true,
              site: { select: { name: true, code: true } },
            },
          },
        },
      },
      events: {
        orderBy: { createdAt: "asc" }, // chronological — newest LAST for the model
        select: {
          kind: true,
          message: true,
          createdAt: true,
          actor: { select: { name: true } },
        },
      },
      alerts: {
        orderBy: { lastSeen: "desc" },
        take: MAX_INCIDENT_ALERTS,
        select: {
          severity: true,
          status: true,
          message: true,
          count: true,
          firstSeen: true,
          lastSeen: true,
          device: { select: { hostname: true } },
        },
      },
    },
  });
  // Fused-404 (F-031 wave 9): an incident whose site is outside the
  // session's scope answers the same not-found null as a missing row —
  // mirroring the dashboard's `site.code IN (…)` incident legs (a null-site
  // incident is row-level hidden from sites-limited sessions there too).
  if (
    !incident ||
    !sessionAllowsSite(scopeClaims, incident.site?.code ?? null)
  ) {
    return null;
  }

  const lines: string[] = [];
  const totalEvents = incident.events.length;
  const events = incident.events.slice(-MAX_TIMELINE_EVENTS);

  lines.push("INCIDENT RECORD");
  lines.push(
    `- ${incident.number} [${incident.severity}${incident.priority ? ` / priority ${incident.priority}` : ""}] status ${incident.status} source ${incident.source}`
  );
  lines.push(`- Title: ${clip(incident.title, 200)}`);
  if (incident.description) lines.push(`- Description: ${clip(incident.description, 600)}`);
  if (incident.site) lines.push(`- Site: ${incident.site.name} (${incident.site.code})`);
  if (incident.owner || incident.ownerTeam) {
    lines.push(
      `- Owner: ${incident.owner?.name ?? incident.owner?.email ?? "unassigned"}${incident.ownerTeam ? ` (team ${incident.ownerTeam})` : ""}`
    );
  }
  lines.push(
    `- Created ${iso(incident.createdAt)} | Acknowledged ${iso(incident.acknowledgedAt)} | Resolved ${iso(incident.resolvedAt)} | Closed ${iso(incident.closedAt)} | SLA due ${iso(incident.slaDueAt)}`
  );
  if (incident.rootCause || incident.correctiveAction || incident.preventiveAction) {
    lines.push("- Existing review notes:");
    if (incident.rootCause) lines.push(`  - Root cause (as recorded): ${clip(incident.rootCause, 300)}`);
    if (incident.correctiveAction) lines.push(`  - Corrective (as recorded): ${clip(incident.correctiveAction, 300)}`);
    if (incident.preventiveAction) lines.push(`  - Preventive (as recorded): ${clip(incident.preventiveAction, 300)}`);
  }

  lines.push(`AFFECTED DEVICES (${incident.devices.length})`);
  for (const link of incident.devices) {
    lines.push(
      `- ${link.device.hostname}: status ${link.device.status}${link.device.model ? `, ${link.device.model}` : ""}${link.device.site ? `, site ${link.device.site.code}` : ""}, mgmt ${link.device.mgmtIp}`
    );
  }

  lines.push(`LINKED ALERTS (${incident.alerts.length})`);
  if (incident.alerts.length === 0) lines.push("- (none linked)");
  for (const alert of incident.alerts) {
    lines.push(
      `- [${alert.severity}/${alert.status}] x${alert.count} on ${alert.device?.hostname ?? "unknown device"} first ${iso(alert.firstSeen)} last ${iso(alert.lastSeen)} — ${clip(alert.message)}`
    );
  }

  if (incident.change) {
    lines.push(
      `LINKED CHANGE: ${incident.change.number} "${clip(incident.change.title, 140)}" status ${incident.change.status} risk ${incident.change.riskLevel}`
    );
  }

  lines.push(`TIMELINE (${events.length}${events.length < totalEvents ? ` of ${totalEvents}` : ""} events, chronological — newest last)`);
  if (events.length === 0) lines.push("- (empty timeline)");
  events.forEach((event, index) => {
    lines.push(
      `${index + 1}. ${iso(event.createdAt)} [${event.kind}] ${clip(event.message)}${event.actor?.name ? ` (by ${event.actor.name})` : ""}`
    );
  });

  return {
    text: lines.join("\n"),
    summary: {
      alertsConsidered: incident.alerts.length,
      eventsConsidered: events.length,
      incidentsConsidered: 1,
    },
  };
}
