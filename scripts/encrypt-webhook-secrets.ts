/**
 * One-time migration — encrypt legacy PLAINTEXT webhook signing secrets at
 * rest (P1-011, external ULTRA audit).
 *
 * Rows created before P1-011 store the raw HMAC signing secret in
 * WebhookEndpoint.secret. This script re-encrypts every legacy row under
 * the deployment KEK (FAYANMS_CONFIG_ENC_KEY) with an AAD context binding
 * the ciphertext to the endpoint's id — the same envelope new creations
 * write. Encrypted rows (enc1: prefix) are skipped, so the script is
 * idempotent and safe to re-run after KEK rotation (bump
 * FAYANMS_CONFIG_ENC_KEY_ID first, then re-run to re-encrypt under the new
 * keyId — the decrypt path refuses envelopes minted by an unavailable key).
 *
 * Run with: DATABASE_URL=... bun scripts/encrypt-webhook-secrets.ts
 */
import { PrismaClient } from "@prisma/client";

import { decryptAtRest, encryptAtRest, webhookSecretAad } from "../src/lib/config/crypto";

const LEGACY_PREFIX = "enc1:";

async function main() {
  const db = new PrismaClient();
  try {
    const rows = await db.webhookEndpoint.findMany({
      select: { id: true, name: true, secret: true },
    });
    let encrypted = 0;
    let skipped = 0;
    for (const row of rows) {
      if (row.secret.startsWith(LEGACY_PREFIX)) {
        skipped += 1;
        continue;
      }
      // Legacy plaintext: verify it decrypts (pass-through) before
      // re-encrypting, then bind the new envelope to the row id.
      const plain = decryptAtRest(row.secret, webhookSecretAad(row.id));
      const envelope = encryptAtRest(plain, webhookSecretAad(row.id));
      await db.webhookEndpoint.update({
        where: { id: row.id },
        data: { secret: envelope },
      });
      encrypted += 1;
      console.log(`encrypted: ${row.id} (${row.name})`);
    }
    console.log(
      `done — ${encrypted} row(s) encrypted, ${skipped} already encrypted, ${rows.length} total`
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error("migration failed:", error);
  process.exitCode = 1;
});
