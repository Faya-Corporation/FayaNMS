/**
 * FayaNMS — fresh-install DEV service-identity bootstrap (GA-OPS wave).
 *
 * `ops dev` needs the two-plane EdDSA service identity (ULTRA P1-007: the
 * shared-secret HS256 plane is legacy; asymmetric identity is the posture),
 * a NEXTAUTH session secret and the config-snapshot encryption key. A fresh
 * clone has none of these — this script generates them ONCE into
 * `.fayanms/dev-identity.env` (gitignored, mode 600) with per-install
 * RANDOM material, exactly the same formats `scripts/generate-service-keys.ts`
 * produces for production.
 *
 * SECURITY POSTURE (honest labeling):
 *   - dev-only material for 127.0.0.1 local flows; never committed
 *     (.gitignore pins `.fayanms/`); never used by production deploys —
 *     production keys come from the operator's deploy/oci env files
 *     (SEC-ENV-001) through a secure channel.
 *   - idempotent: if the file exists it is left untouched (re-running never
 *     rotates keys silently — rotation is an explicit operator action).
 *
 * Usage: bun ops/bootstrap-dev-identity.ts [--out <path>]
 *   Default output: <repoRoot>/.fayanms/dev-identity.env
 *   Lines are KEY=value (no `export` prefix) so both bash (`. file`) and
 *   PowerShell (per-line parse) consume the same artifact.
 */

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const outPath = path.resolve(argValue("--out") ?? path.join(ROOT, ".fayanms", "dev-identity.env"));

if (existsSync(outPath)) {
  console.log(`[ops] dev identity already present — left untouched: ${outPath}`);
  process.exit(0);
}

function ed25519Pair(): { privateSingleLine: string; publicSpkiBase64: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateSingleLine = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString("utf8")
    .trim()
    .replaceAll("\n", "\\n");
  const publicSpkiBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { privateSingleLine, publicSpkiBase64 };
}

const control = ed25519Pair(); // mints app->worker tokens
const worker = ed25519Pair(); // mints worker->app tokens (incl. self-call plane)

const lines = [
  "# FayaNMS DEV service identity — GENERATED, per-install, local-only.",
  "# Never commit this file (.gitignore pins .fayanms/). Production uses the",
  "# operator-managed deploy/oci env files (SEC-ENV-001) — never these values.",
  "# Values are double-quoted (PEM material contains spaces); bash sources the",
  "# file directly, PowerShell parses KEY=\"value\" lines.",
  `DEV_NEXTAUTH_SECRET="${randomBytes(32).toString("hex")}"`,
  `DEV_CONFIG_ENC_KEY="${randomBytes(32).toString("hex")}"`,
  `DEV_CONTROL_PRIVATE_KEY="${control.privateSingleLine}"`,
  `DEV_CONTROL_PUBLIC_KEY="${control.publicSpkiBase64}"`,
  `DEV_WORKER_PRIVATE_KEY="${worker.privateSingleLine}"`,
  `DEV_WORKER_PUBLIC_KEY="${worker.publicSpkiBase64}"`,
  "",
];

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join("\n"), { mode: 0o600 });
try {
  chmodSync(outPath, 0o600);
} catch {
  /* best-effort on platforms without POSIX modes */
}
console.log(`[ops] dev identity generated: ${outPath}`);
