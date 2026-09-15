# FayaNMS — Public Demo Device Fleet (real-device evidence without a hardware lab)

**Status date:** 2026-09-16 (Asia/Riyadh) · **Task:** TASK-DEMO-FLEET-001 · **Tool:** `bun run demo:fleet` (`scripts/demo-fleet-probe.ts`)
**Prime rule (inherits MATRIX.md):** a capability is claimed ONLY at the highest tier actually evidenced. Public-demo evidence is **real-device auth/read evidence** — it is NOT T3, and it never satisfies the drift/change/rollback/interruption/restore rows.

---

## 1. Why this plane exists

`CERT-HW-001-A` is honestly classified **REAL-HARDWARE BLOCKED** — the sandbox has no appliances. But the answer to "can we use real free demo devices for monitoring" is **YES for the LIVE_SSH plane**: the sandbox reaches real, free, public vendor demo devices over SSH, and the product's certified `cisco` LIVE_SSH flavor can drive them. This document is the trust boundary, the procedure, and the evidence log for that plane.

Empirical feasibility (this sandbox, 2026-09-16):

| Check | Result |
|---|---|
| DNS resolution of DevNet always-on hosts | OK (`devnetsandboxiosxe.cisco.com` → 131.226.217.182, `sbx-nxos-mgmt.cisco.com` → 131.226.217.151) |
| TCP/22 to `devnetsandboxiosxe.cisco.com` | **OPEN** — 180 ms connect |
| TCP/22 to `sbx-nxos-mgmt.cisco.com` | **OPEN** — 173 ms connect |
| HTTPS egress | OK (HTTP 200) |
| ICMP to public endpoints | **BLOCKED** (containerized sandbox — no raw sockets; ICMP probes are not a FayaNMS transport) |

Reproduce any time with `bun run demo:fleet` (TCP preflight, no credentials needed).

## 2. The catalog (honest, per-device)

| Device | Host | FayaNMS flavor | Credential model | Notes |
|---|---|---|---|---|
| Cisco DevNet Always-On Catalyst 8000 (IOS-XE) | `devnetsandboxiosxe.cisco.com:22` | `cisco` (certified LIVE_SSH) | `devnet-aaa-per-user` | **The one enrollable public SSH device today.** |
| Cisco DevNet Always-On NX-OS | `sbx-nxos-mgmt.cisco.com:22` | **none (reference only)** | `devnet-aaa-per-user` | NOT enrollable — no certified NX-OS flavor; cataloged for reachability evidence only. |

Per-vendor public availability (why the fleet is Cisco-only today):

| Vendor | Free public always-on SSH device? | Free fallback path |
|---|---|---|
| cisco-ios | **YES** — DevNet Cat8000 (per-user AAA since 2025-09-16) | — |
| fortinet-fortios | No — Fortinet's public demo is a web UI, not SSH | Free FortiGate VM (operator-hosted lab) |
| hpe-aos-cx | No | Free AOS-CX simulator VM (operator-hosted lab) |
| juniper-junos | No — Juniper publishes free vJunos/vMX **downloads**, not hosted devices | vJunos/vMX in EVE-NG/GNS3/KVM (operator-hosted) |
| palo-panos | No — public demo is web-only | Free PAN-OS VM mode (operator-hosted) |
| sophos (SFOS WebAPI) | No public demo API endpoint | Free SFOS home/lab license (operator-hosted) |

**Credential policy — the 2025-09-16 change:** Cisco retired shared sandbox credentials ("no longer provide a single username and password for everyone … creating unique credentials using AAA" — Cisco DevNet community, "New Always-On DevNet Sandbox for Cisco Catalyst 8000", 2025-09-16). An operator obtains credentials from a **free** DevNet account (https://developer.cisco.com/sandbox/). **No credential ever enters this repository** — the probe refuses to run its SSH stage without `FAYANMS_DEMO_SSH_HOST` / `FAYANMS_DEMO_SSH_USER` / `FAYANMS_DEMO_SSH_PASS` (typed `DEMO_SSH_CREDS_MISSING`, exit 2, before any network activity).

## 3. READ-ONLY trust boundary (never violated on shared devices)

1. Public demo devices are **shared infrastructure** — mutation against them is out of scope forever. The probe's only command literals are `show version` and the certified flavor's `show running-config`; the transport is exec-only (SAFE-001 pinning/enrollment semantics); the governance suite fails if a mutation-shaped command literal (`conf t`, `reload`, `write`, `copy running`, `erase`, `reboot`) ever enters the tool.
2. Host keys are **enrollment-captured** (the presented fingerprint is recorded, nothing is enforced) — the printed `SHA256:…` fingerprint is what the operator pins for subsequent runs through the normal SAFE-001 enrollment flow. Never blind-trust a first connection in the app plane.
3. Evidence collected here feeds only the **auth/read** rows of the lab procedure (MATRIX.md §3 steps 1–3 analogue). Drift (step 4), controlled change (step 5), failure path (step 6), interruption (step 7), rotation (step 8) and the restore decision (step 9) REQUIRE the section-3 lab — a dedicated physical **or operator-hosted virtual** appliance (free VM downloads exist per the table above).

## 4. Procedure (one real-device evidence run, zero hardware cost)

1. **Preflight (no credentials):** `bun run demo:fleet` → expect `OPEN` for the Cat8000 entry. If a previously-OPEN device goes dark, record it in §5 and re-check DevNet's catalog — public sandboxes rotate.
2. **Credentials:** create/sign in to a free DevNet account → open the Cat8000 sandbox → copy the per-user AAA username/password.
3. **SSH probe + transcript:** `FAYANMS_DEMO_SSH_HOST=devnetsandboxiosxe.cisco.com FAYANMS_DEMO_SSH_USER=<user> FAYANMS_DEMO_SSH_PASS=<pass> bun run demo:fleet -- --ssh` → captures latency, the presented host-key fingerprint, and the `show version` transcript.
4. **Backup through the product adapter:** add `--backup` → runs the certified `cisco` LIVE_SSH adapter (`show running-config`) — the SAME code path a real enrolled device backup uses. Paste nothing into the repo; record byte/line counts and the snapshot integrity hash in §5.
5. **Optional full-plane run:** enroll the device in the app (device + vault credential + host-key pin from step 3) and run a probe/backup job through app→worker — that is the T2-stack-on-a-REAL-device analogue and the strongest public-demo evidence available.
6. **Record:** add a dated row to §5 (device, stage, result, fingerprint ref, transcript artifact). Rows are signed like MATRIX.md §3 — never inferred.

## 5. PUBLIC DEMO EVIDENCE LOG

| Date (Asia/Riyadh) | Device | Stage | Result | Evidence |
|---|---|---|---|---|
| 2026-09-16 | devnet-cat8000-iosxe | TCP preflight | **OPEN** — 180 ms | this doc §1 (reproducible via `bun run demo:fleet`) |
| 2026-09-16 | devnet-nxos | TCP preflight | **OPEN** — 173 ms (reference only; not enrollable) | this doc §1 |
| 2026-09-16 | — | SSH auth/read | **PENDING OPERATOR CREDS** — per-user DevNet AAA required (§2 policy); shared-credential era ended 2025-09-16 | this doc §2/§4 |

> Classification (restating the prime rule): even a fully green §5 does **not** move any MATRIX.md row to T3. It strengthens release confidence for the auth/read plane against a real device and de-risks the first lab session; the certification matrix stays lab-gated.
