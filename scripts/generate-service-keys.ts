/**
 * P1-007 — generate an Ed25519 keypair for the asymmetric service-identity
 * plane (ULTRA audit: "HS256 shared-secret only; holder of the secret can
 * mint any token").
 *
 * Usage:  bun scripts/generate-service-keys.ts
 *
 * Output is a ready-to-paste env block:
 *   FAYANMS_SERVICE_PRIVATE_KEY — the MINTER's identity (PKCS8 PEM with
 *     escaped \n newlines so it fits a single-line env value). Each minter
 *     (Next.js control plane AND the worker, in the two-plane topology)
 *     gets its OWN keypair.
 *   FAYANMS_SERVICE_PUBLIC_KEY  — the matching verifier material (SPKI DER
 *     base64; set on the OPPOSITE side's FAYANMS_SERVICE_PUBLIC_KEYS,
 *     comma-separated so rotations can overlap).
 *
 * Rotation runbook (docs/deploy security note 17):
 *   Phase 1 — deploy the new public key into every verifier's
 *     FAYANMS_SERVICE_PUBLIC_KEYS list (both planes accept both algorithms
 *     while FAYANMS_SERVICE_SECRET remains configured; minters prefer the
 *     private key immediately).
 *   Phase 2 — remove FAYANMS_SERVICE_SECRET(S) from every process. HS256
 *     tokens become structurally impossible (SERVICE_ALG_REJECTED /
 *     WORKER_ALG_REJECTED) and the shared-secret holder's minting power is
 *     gone.
 */

import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const spkiDerBase64 = publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
const pkcs8Pem = privateKey.export({ format: "pem", type: "pkcs8" });
const pkcs8SingleLine = pkcs8Pem
  .toString("utf8")
  .trim()
  .replaceAll("\n", "\\n");

console.log(`
# P1-007 asymmetric service identity — generated Ed25519 keypair
#
# Two-plane topology (recommended):
#   CONTROL keypair: FAYANMS_SERVICE_PRIVATE_KEY on the Next.js process;
#     its FAYANMS_SERVICE_PUBLIC_KEY goes into the WORKER's
#     FAYANMS_SERVICE_PUBLIC_KEYS.
#   WORKER keypair:  run this script again; the private key goes on the
#     worker, its public key into the Next.js FAYANMS_SERVICE_PUBLIC_KEYS.
#   (FAYANMS_SERVICE_PUBLIC_KEYS accepts a comma-separated list — old and
#    new keys can overlap during rotation.)
#
# While FAYANMS_SERVICE_SECRET remains configured BOTH algorithms are
# accepted (rotation Phase 1); minters prefer EdDSA immediately. Remove the
# shared secret everywhere to complete Phase 2.

# Minter side (this process signs with it):
FAYANMS_SERVICE_PRIVATE_KEY=${pkcs8SingleLine}

# Verifier side (the OPPOSITE plane's FAYANMS_SERVICE_PUBLIC_KEYS):
FAYANMS_SERVICE_PUBLIC_KEY=${spkiDerBase64}
`);
