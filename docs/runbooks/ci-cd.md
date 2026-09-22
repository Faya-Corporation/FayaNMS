# FayaNMS CI/CD runbook

## Certification order

1. Pull request runs CI gate: gate, e2e, browser, and scan.
2. Pull request runs ARM64 build/runtime smoke and image scan.
3. Merge is allowed only after owner-configured required checks and review.
4. Main CI reruns the exact merge SHA.
5. Container publication uses the exact successful main SHA and publishes app, worker, and migration images with SHA tags.
6. Staging deploy consumes the exact SHA tag; it does not rebuild from source.
7. Health/smoke and backup evidence are attached to the release record.

## Failure rules

- A red browser, security, migration, image, or smoke job blocks release.
- Do not add continue-on-error, skip tests, weaken assertions, or accept a nonzero build exit merely because artifacts exist.
- Retain Playwright/app/worker logs and scan artifacts on failure.
- Treat a mutable tag as a convenience alias only; the deployment contract requires the full commit SHA.

## Action permissions

CI defaults to contents read. GHCR publication grants packages write only to the publish job. Deployment uses the protected staging environment and host-side package-read credentials. No repository-admin PAT is part of the pipeline contract.

## Current boundary

Branch protection, GitHub environment approvals, GHCR package visibility, OCI host enrollment, DNS, VPN, physical hardware, and production approvals remain owner/external actions until live readback proves them.
