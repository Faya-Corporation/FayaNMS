/**
 * P19 / audit SEC-003 — one-time at-rest encryption migration.
 * Phase 19-C (audit CRYPTO-101) — AAD-binding upgrade.
 *
 * Encrypts every ConfigSnapshot row that still stores plaintext
 * (encKeyId = null: pre-P19 seed data or rows written before this phase)
 * under the AES-256-GCM envelope of src/lib/config/crypto.ts. Already-
 * encrypted rows are skipped, so the script is IDEMPOTENT and can be
 * re-run after a master-key rotation (bump FAYANMS_CONFIG_ENC_KEY_ID, set
 * the new FAYANMS_CONFIG_ENC_KEY, run again — keyId-scoped keyring support
 * for reading under old keys arrives in Phase 21; until then rotate by
 * re-encrypting everything at once).
 *
 * Phase 19-C additionally re-encrypts every row whose envelope predates
 * the AAD binding (encAad = null but encKeyId set) so the WHOLE table ends
 * up bound to its row identity (device/version/configType/source) — a
 * ciphertext transplanted between rows now fails GCM authentication.
 *
 * Usage (STOP the dev server first — this writes the SQLite database file
 * outside the application's transaction boundaries):
 *
 *   bun run db:push          # apply the envelope columns first
 *   bun scripts/migrate-encrypt-snapshots.ts
 *
 * Post-conditions asserted at the end:
 *   - zero rows remain with encKeyId = null;
 *   - zero encrypted rows remain without an encAad binding;
 *   - every encrypted row round-trips (decrypt(encrypt(plain)) === plain,
 *     verified against the recorded plaintext sha256 column).
 */

import { PrismaClient } from "@prisma/client";

import {
  decryptSnapshotTexts,
  prepareSnapshotColumns,
  snapshotAad,
} from "../src/lib/config/crypto";

const db = new PrismaClient();

const BATCH = 25;

const ENVELOPE_SELECT = {
  id: true,
  rawText: true,
  normalizedText: true,
  sha256: true,
  encKeyId: true,
  encIv: true,
  encTag: true,
  normIv: true,
  normTag: true,
  wrappedDek: true,
  wrapIv: true,
  wrapTag: true,
  encAad: true,
} as const;

async function main(): Promise<void> {
  const total = await db.configSnapshot.count();
  const legacy = await db.configSnapshot.count({ where: { encKeyId: null } });
  const noAad = await db.configSnapshot.count({
    where: { encKeyId: { not: null }, encAad: null },
  });
  console.log(
    `[migrate] snapshots total=${total} legacyPlaintext=${legacy} alreadyEncrypted=${total - legacy} encryptedWithoutAad=${noAad}`
  );

  let migrated = 0;
  // Idempotent cursor loop over legacy rows.
  for (;;) {
    const rows = await db.configSnapshot.findMany({
      where: { encKeyId: null },
      select: {
        id: true,
        rawText: true,
        normalizedText: true,
        sha256: true,
        deviceId: true,
        version: true,
        configType: true,
        source: true,
      },
      take: BATCH,
      orderBy: { createdAt: "asc" },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      const columns = prepareSnapshotColumns(
        row.rawText,
        row.normalizedText,
        snapshotAad({
          deviceId: row.deviceId,
          version: row.version,
          configType: row.configType,
          source: row.source,
        })
      );
      await db.configSnapshot.update({
        where: { id: row.id },
        data: columns,
      });

      // Round-trip verification against the recorded PLAINTEXT sha256.
      const stored = await db.configSnapshot.findUnique({
        where: { id: row.id },
        select: ENVELOPE_SELECT,
      });
      if (!stored || !stored.encKeyId) {
        throw new Error(`[migrate] row ${row.id} did not persist its envelope`);
      }
      const texts = decryptSnapshotTexts(stored);
      // Strongest integrity check: the decrypted plaintext must hash to the
      // sha256 column (which was computed over the plaintext pre-encryption).
      const { createHash } = await import("node:crypto");
      const roundTripSha = createHash("sha256").update(texts.rawText).digest("hex");
      if (roundTripSha !== row.sha256) {
        throw new Error(
          `[migrate] row ${row.id} round-trip sha mismatch (${roundTripSha} vs ${row.sha256})`
        );
      }

      migrated += 1;
      if (migrated % 50 === 0) {
        console.log(`[migrate] progress: ${migrated} rows re-encrypted`);
      }
    }
  }

  // Phase 19-C: upgrade pre-19-C encrypted rows to AAD-bound envelopes.
  let aadUpgraded = 0;
  for (;;) {
    const rows = await db.configSnapshot.findMany({
      where: { encKeyId: { not: null }, encAad: null },
      select: {
        id: true,
        rawText: true,
        normalizedText: true,
        sha256: true,
        deviceId: true,
        version: true,
        configType: true,
        source: true,
      },
      take: BATCH,
      orderBy: { createdAt: "asc" },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      // Decrypt under the legacy (AAD-free) envelope first — if this fails
      // the row was already tampered; abort instead of re-encrypting garbage.
      const stored = await db.configSnapshot.findUnique({
        where: { id: row.id },
        select: ENVELOPE_SELECT,
      });
      if (!stored || !stored.encKeyId) {
        throw new Error(`[aad-upgrade] row ${row.id} lost its envelope mid-run`);
      }
      const texts = decryptSnapshotTexts(stored);
      const columns = prepareSnapshotColumns(
        texts.rawText,
        texts.normalizedText,
        snapshotAad({
          deviceId: row.deviceId,
          version: row.version,
          configType: row.configType,
          source: row.source,
        })
      );
      await db.configSnapshot.update({
        where: { id: row.id },
        data: columns,
      });

      // Verify the upgraded row round-trips under its new AAD binding.
      const recheck = await db.configSnapshot.findUnique({
        where: { id: row.id },
        select: ENVELOPE_SELECT,
      });
      if (!recheck) throw new Error(`[aad-upgrade] row ${row.id} vanished`);
      const upgraded = decryptSnapshotTexts(recheck);
      const { createHash } = await import("node:crypto");
      if (
        createHash("sha256").update(upgraded.rawText).digest("hex") !== row.sha256
      ) {
        throw new Error(`[aad-upgrade] row ${row.id} sha mismatch after upgrade`);
      }

      aadUpgraded += 1;
      if (aadUpgraded % 50 === 0) {
        console.log(`[migrate] AAD upgrade progress: ${aadUpgraded} rows`);
      }
    }
  }

  const remaining = await db.configSnapshot.count({ where: { encKeyId: null } });
  const remainingNoAad = await db.configSnapshot.count({
    where: { encKeyId: { not: null }, encAad: null },
  });
  console.log(
    `[migrate] DONE migrated=${migrated} aadUpgraded=${aadUpgraded} remainingPlaintext=${remaining} remainingWithoutAad=${remainingNoAad}`
  );
  if (remaining !== 0 || remainingNoAad !== 0) {
    throw new Error("[migrate] FAILED — unprotected rows remain");
  }
  console.log(
    "[migrate] every ConfigSnapshot row is now AES-256-GCM encrypted AND AAD-bound at rest."
  );
}

main()
  .catch((error) => {
    console.error("[migrate] FAILED:", error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
