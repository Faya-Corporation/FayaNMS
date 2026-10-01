# Observability runbook

The repository contains Prometheus and OpenTelemetry configuration as a staging foundation. The app exposes non-sensitive process metrics at /api/metrics; Caddy returns 404 for that route on public ingress. Set FAYANMS_METRICS_TOKEN and configure an internal Prometheus bearer credential before enabling remote scraping. It does not claim that application metrics, device telemetry, or collector metrics are live until endpoints and CI/staging evidence exist.

## Evidence states

Record these independently:

- config present;
- endpoint implemented;
- container tested;
- CI certified;
- staging scraped;
- alert rule fired in a controlled test;
- production proven.

A Prometheus target returning no metrics is a finding, not a green result.

## Start the internal monitoring profile

The three monitoring image references in deploy/oci/compose.monitoring.yml are now pinned to reviewed SHA-256 digests. Before enabling the profile, the operator must independently verify that each exact digest is available for the OCI host architecture, scan those exact images, and retain the staging burn-in evidence. Digest pinning alone is not staging or production proof.

~~~bash
cd /opt/fayanms
docker compose --env-file .env -f compose.yml -f compose.monitoring.yml --profile monitoring up -d
docker compose --env-file .env -f compose.yml -f compose.monitoring.yml --profile monitoring ps
~~~

Prometheus and Grafana are not published to the public host interface. Access them only through a controlled administrator tunnel or a separately reviewed authenticated proxy.

## Required future instrumentation

App and worker must expose authenticated or network-restricted metrics for request latency/error, DB pool, queue age/depth, job outcomes, worker heartbeat, device transport, backup, change execution, and collector health. Configure OTLP trace export only after endpoint and redaction tests pass.

## Alerts

Before calling the stack operational, add and test alerts for service down, PostgreSQL unavailable, queue growth, worker/collector missing, abnormal job failures, disk/memory pressure, and certificate expiry. Retain the firing evidence with the deployment SHA.

Starter rules ship in `monitoring/rules/fayanms-starter.yml` (mounted read-only into the monitoring-profile Prometheus at `/etc/prometheus/rules/`): app down, worker down, worker scheduler failing, and protocol-queue drops. PostgreSQL-down and certificate-expiry are intentionally commented placeholders in that file — they require an exporter decision (postgres_exporter / blackbox or SSL exporter) before any rule can reference a real metric. No alertmanager is configured: alerts evaluate in Prometheus only (review them at `/alerts` over the admin tunnel).
