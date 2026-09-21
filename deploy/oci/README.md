# FayaNMS OCI staging

This directory contains repository-side automation for an ARM64 OCI staging host. It does not create OCI resources, DNS, VPNs, physical-device connections, or secrets.

## Required external actions

The operator must provide, through a secure channel:

- OCI tenancy, region, compartment, VCN, subnet, NSG, reserved public IP, and ARM64 VM;
- SSH public key and a controlled administrator source range;
- staging DNS A/AAAA record and ACME contact;
- a read-only GHCR package credential on the host;
- generated PostgreSQL, NextAuth, service identity, and encryption values;
- approval for the GitHub staging environment;
- VPN and lab VLAN details only after the isolated staging controls are validated.

Do not put these values in GitHub files or issue comments.

## Host layout

Install this directory on the host as /opt/fayanms:

~~~text
/opt/fayanms/
  compose.yml
  compose.monitoring.yml
  Caddyfile
  .env                 # mode 600, never committed
  data/
  backups/
  logs/
  state/
~~~

Copy env.example to the host through a secure channel, replace every SET_ON_HOST_ONLY value, then enforce mode 600. Use full commit SHA tags for all three FayaNMS images. The deploy script refuses mutable or mismatched tags.

## First bootstrap

~~~bash
sudo ./bootstrap.sh
sudo install -m 600 /secure-transfer/fayanms.env /opt/fayanms/.env
sudo docker login ghcr.io
sudo ./deploy.sh <full-commit-sha>
~~~

The GHCR login must use a package-read credential scoped only to the required private packages. The deployment host must not use a repository-admin PAT.

The migration image is intentionally separate from the runtime image. It must be published for the same source SHA and is used only for prisma migrate deploy. If the migration image is unavailable, deployment stops; it does not fall back to db push or an unreviewed source build.

## External ingress

Only Caddy publishes TCP 80 and 443. PostgreSQL, app port 3000, worker port 3030, Prometheus, Grafana, and collector ports remain internal or VPN/lab restricted. The production deployment must use the hardened Compose file; the repository base compose profile is not an OCI production substitute.

## Evidence

After each deployment retain:

- source commit SHA;
- app, worker, and migrator image digests;
- deployment timestamp;
- migration output without secrets;
- health-check output;
- smoke-test output;
- backup verification result;
- CI run and PR reference.

## Status

Repository automation: implemented and testable in CI.

OCI resource creation, DNS, GHCR host login, GitHub environment approval, VPN, hardware certification, and staging burn-in: BLOCKED — EXTERNAL until the operator supplies and executes the runbook actions.
