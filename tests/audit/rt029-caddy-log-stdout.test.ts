import { expect, test } from "bun:test";

/**
 * RT-029 / F-058 — Caddy access logs: stdout (docker-owned retention)
 * instead of the container-local file.
 *
 * BEFORE: `log { output file /var/log/caddy/fayanms-access.log }` pointed
 * at a directory the official caddy:2-alpine image does not ship and the
 * compose service does not mount (likely first-boot provision failure →
 * crash-loop → deploy health gate fails), and container-local files are
 * lost on recreation anyway.
 *
 * AFTER: `output stdout` + `format json` — docker's json-file driver
 * (compose caddy service: max-size 10m / max-file 5) owns retention.
 * Config police, style of monitoring-compose.test.ts:
 *   1. the Caddyfile logs to stdout and NO file output remains;
 *   2. no orphaned /var/log/caddy reference anywhere in deploy/oci/;
 *   3. the JSON format is preserved (runbook query examples stay valid);
 *   4. docker log rotation is still configured on the caddy service.
 */

const caddyfile = await Bun.file("deploy/oci/Caddyfile").text();
const compose = await Bun.file("deploy/oci/compose.yml").text();

function serviceBlock(composeText: string, service: string): string {
  const lines = composeText.split("\n");
  const start = lines.indexOf("  " + service + ":");
  expect(start).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => /^  \w/.test(line));
  return (next === -1 ? rest : rest.slice(0, next)).join("\n");
}

test("caddy logs to stdout (no file output remains)", () => {
  expect(caddyfile).toContain("log {");
  expect(caddyfile).toMatch(/output\s+stdout/);
  expect(caddyfile).not.toMatch(/output\s+file/);
});

test("no orphaned log volume/dir reference anywhere in deploy/oci/", () => {
  expect(caddyfile).not.toContain("/var/log/caddy");
  expect(compose).not.toContain("/var/log/caddy");
  // The caddy service mounts stay minimal (Caddyfile + data + config).
  const block = serviceBlock(compose, "caddy");
  const volumesStart = block.indexOf("volumes:");
  const volumes = block.slice(volumesStart, block.indexOf("networks:"));
  expect(volumes).toContain("./Caddyfile:/etc/caddy/Caddyfile:ro");
  expect(volumes).toContain("caddy-data:/data");
  expect(volumes).toContain("caddy-config:/config");
  expect(volumes).not.toContain("/var/log");
});

test("json format preserved (structured access logs)", () => {
  const logBlock = caddyfile.slice(caddyfile.indexOf("log {"));
  expect(logBlock).toMatch(/format\s+json/);
});

test("docker log rotation still configured on the caddy service (retention owner)", () => {
  const block = serviceBlock(compose, "caddy");
  expect(block).toContain("driver: json-file");
  expect(block).toContain("max-size: 10m");
  expect(block).toContain('max-file: "5"');
});
