import { expect, test } from "bun:test";

/**
 * RT-030 / F-060 — starter Prometheus alert rules exist, are mounted, and
 * reference ONLY metrics the app/worker emitters actually serve.
 *
 * BEFORE: monitoring/prometheus.yml wired `rule_files: /etc/prometheus/
 * rules/*.yml` but no rules file existed anywhere in the repo — monitoring
 * was scrape-only while the runbook's own operational bar ("add and test
 * alerts for service down, PostgreSQL unavailable, queue growth, …")
 * was unmet. The stack could be silently unmonitored.
 *
 * Config police, style of monitoring-compose.test.ts:
 *   1. the rules file exists and parses (≥ 3 complete alert rules);
 *   2. ANTI-INVENTED-METRIC guard: every ACTIVE expr references only
 *      emitter metrics (fayanms_*) or `up` — PG/cert rules must stay
 *      commented placeholders until an exporter decision lands;
 *   3. compose.monitoring.yml mounts ./monitoring/rules/ read-only;
 *   4. the rule_files glob in prometheus.yml matches the mounted path.
 */

const rulesText = await Bun.file("monitoring/rules/fayanms-starter.yml").text();
const prometheusYml = await Bun.file("monitoring/prometheus.yml").text();
const monitoringCompose = await Bun.file("deploy/oci/compose.monitoring.yml").text();
const appMetricsRoute = await Bun.file("src/app/api/metrics/route.ts").text();
const workerIndex = await Bun.file("mini-services/worker/index.ts").text();

interface AlertRule {
  alert: string;
  expr: string;
  block: string[];
}

/** Line-based parse: a rule starts at `- alert:`; comments are inert. */
function parseAlertRules(text: string): AlertRule[] {
  const lines = text.split("\n");
  const rules: AlertRule[] = [];
  let current: AlertRule | null = null;
  let currentIndent = 0;
  for (const line of lines) {
    const active = !line.trimStart().startsWith("#");
    const alertMatch = /^(\s*)-\s*alert:\s*(\S+)/.exec(line);
    if (active && alertMatch) {
      currentIndent = alertMatch[1].length;
      current = { alert: alertMatch[2], expr: "", block: [line] };
      rules.push(current);
      continue;
    }
    if (current) {
      // A dedent below the rule level (e.g. `groups:` / next group) ends it.
      const trimmed = line.trim();
      const indent = line.length - line.trimStart().length;
      if (active && trimmed && indent <= currentIndent && !trimmed.startsWith("- alert:")) {
        current = null;
        continue;
      }
      current.block.push(line);
      const exprMatch = /^\s*expr:\s*(.+)$/.exec(line);
      if (active && exprMatch && current.expr === "") {
        current.expr = exprMatch[1].trim();
      }
    }
  }
  return rules;
}

/** Metric names actually emitted by the app/worker /api/metrics routes. */
function emitterMetrics(): Set<string> {
  const names = new Set<string>();
  for (const source of [appMetricsRoute, workerIndex]) {
    for (const match of source.matchAll(/fayanms_[a-z_]+/g)) {
      names.add(match[0]);
    }
  }
  return names;
}

/** Strip label matchers / durations, then keep non-keyword identifiers. */
const PROMQL_KEYWORDS = new Set([
  "increase", "rate", "irate", "sum", "avg", "min", "max", "count", "count_values",
  "by", "without", "on", "ignoring", "group_left", "group_right", "offset", "bool",
  "and", "or", "unless", "absent", "absent_over_time", "present_over_time",
  "avg_over_time", "sum_over_time", "min_over_time", "max_over_time", "time",
  "vector", "scalar", "delta", "deriv", "histogram_quantile", "label_replace",
  "h", "m", "s", "d", "w", "y",
]);

function exprMetricNames(expr: string): string[] {
  const stripped = expr
    .replace(/\{[^}]*\}/g, "") // label matchers (label names are not metrics)
    .replace(/\[[^\]]*\]/g, ""); // range/vector selectors ([15m])
  return [...stripped.matchAll(/[a-zA-Z_:][a-zA-Z0-9_:]*/g)]
    .map((m) => m[0])
    .filter((name) => !PROMQL_KEYWORDS.has(name));
}

test("rules file exists and parses: ≥ 3 complete alert rules", () => {
  const rules = parseAlertRules(rulesText);
  expect(rules.length).toBeGreaterThanOrEqual(3);
  for (const rule of rules) {
    expect(rule.alert).toMatch(/^Fayanms[A-Za-z]+$/);
    expect(rule.expr).not.toBe("");
    const blockText = rule.block.join("\n");
    // Every rule carries the full usePrometheus-style shape.
    expect(blockText).toMatch(/^\s*for:\s*\S+/m);
    expect(blockText).toMatch(/^\s*labels:\s*$/m);
    expect(blockText).toMatch(/^\s*annotations:\s*$/m);
    expect(blockText).toMatch(/^\s*summary:\s*/m);
    expect(blockText).toMatch(/^\s*description:\s*/m);
  }
  // The starter's pinned roster (runbook bar: app/worker down + queue).
  const names = rules.map((r) => r.alert);
  expect(names).toContain("FayanmsAppDown");
  expect(names).toContain("FayanmsWorkerDown");
  expect(names).toContain("FayanmsWorkerSchedulerDown");
  expect(names).toContain("FayanmsQueueGrowth");
});

test("rule expressions reference real metrics only (anti-invented-metric guard)", () => {
  const emitters = emitterMetrics();
  expect(emitters.size).toBeGreaterThanOrEqual(10); // the emitters are read
  expect(emitters).toContain("fayanms_worker_scheduler_up");
  expect(emitters).toContain("fayanms_worker_protocol_packets_total");

  const rules = parseAlertRules(rulesText);
  expect(rules.length).toBeGreaterThanOrEqual(3);
  for (const rule of rules) {
    const names = exprMetricNames(rule.expr);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name === "up" || emitters.has(name)).toBe(true);
    }
  }

  // PG/cert placeholders stay COMMENTED: the placeholder alert names and
  // their (exporter-only) metrics must never appear on active lines.
  const activeLines = rulesText
    .split("\n")
    .filter((l) => l.trim() && !l.trimStart().startsWith("#"));
  const activeText = activeLines.join("\n");
  expect(activeText).not.toContain("FayanmsPostgresDown");
  expect(activeText).not.toContain("FayanmsCertExpiringSoon");
  expect(activeText).not.toContain("pg_up");
  expect(activeText).not.toContain("probe_ssl_earliest_cert_expiry");
  // …but the honest placeholders ARE present as comments (documented scope).
  expect(rulesText).toContain("# - alert: FayanmsPostgresDown");
  expect(rulesText).toContain("TODO(exporter-decision)");
});

test("compose mounts the rules dir read-only into prometheus", () => {
  expect(monitoringCompose).toContain(
    "./monitoring/rules/:/etc/prometheus/rules/:ro",
  );
});

test("rule_files glob matches the mounted path (wiring sanity)", () => {
  expect(prometheusYml).toMatch(/rule_files:/);
  expect(prometheusYml).toContain("/etc/prometheus/rules/*.yml");
  // The mount target directory is exactly the glob's directory.
  expect("/etc/prometheus/rules/*.yml".startsWith("/etc/prometheus/rules/")).toBe(true);
});
