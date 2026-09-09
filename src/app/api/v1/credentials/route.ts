import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../_lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/credentials — credential profiles for the Credentials view.
 *
 * SECURITY INVARIANT (audit finding F-12): only reference material is ever
 * returned — name, type, username, secretRef (a vault POINTER such as
 * "vault://ssh/network-admin", never a secret), port, notes and timestamps.
 * No secret material exists in this database by design.
 *
 * Usage counts: the CredentialProfile model has no relation to Device in the
 * current schema (device↔credential assignment ships with the schema
 * extension), so deviceCount is always 0 for now — the API shape is ready
 * for _count once the column lands.
 *
 * POST /api/v1/credentials — create a profile. Body: { name, type, username,
 * secretRef, port?, notes? }. secretRef must start with "vault://" — the
 * request carries the vault REFERENCE only, never a secret.
 */

const CREDENTIAL_TYPES = ["SSH_PASSWORD", "SSH_KEY", "API_TOKEN", "SNMPV3", "HTTPS"] as const;

export async function GET() {
  const [profiles, total] = await Promise.all([
    db.credentialProfile.findMany({
      orderBy: { name: "asc" },
    }),
    db.credentialProfile.count(),
  ]);

  // No CredentialProfile↔Device relation in the schema yet — the count is
  // honestly 0 until the device.credentialProfileId column lands.
  const rows = profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    type: profile.type,
    username: profile.username,
    secretRef: profile.secretRef,
    port: profile.port,
    notes: profile.notes,
    lastRotatedAt: profile.lastRotatedAt?.toISOString() ?? null,
    deviceCount: 0,
  }));

  return ok(rows, { total });
}

const createSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(80),
  type: z.enum(CREDENTIAL_TYPES).default("SSH_PASSWORD"),
  username: z.string().trim().min(1, "username is required").max(80),
  secretRef: z
    .string()
    .trim()
    .min(1, "secretRef is required")
    .max(200)
    .startsWith("vault://", "secretRef must point into the vault (vault://…)"),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  notes: z.string().trim().max(2000).optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const data = parsed.data;

  const existing = await db.credentialProfile.findUnique({
    where: { name: data.name },
    select: { id: true },
  });
  if (existing) {
    return fail(
      "CREDENTIAL_NAME_TAKEN",
      `A credential profile named "${data.name}" already exists`,
      409
    );
  }

  const correlationId = newJobCorrelationId();

  const profile = await db.$transaction(async (tx) => {
    const created = await tx.credentialProfile.create({
      data: {
        name: data.name,
        type: data.type,
        username: data.username,
        secretRef: data.secretRef,
        port: data.port,
        notes: data.notes,
      },
    });
    await tx.auditEvent.create({
      data: {
        actorName: "admin",
        action: "CREDENTIAL_CREATED",
        resourceType: "CredentialProfile",
        resourceId: created.id,
        resourceLabel: created.name,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          name: created.name,
          type: created.type,
          username: created.username,
          secretRef: created.secretRef,
          port: created.port,
        }),
      },
    });
    return created;
  });

  return ok(
    {
      profile: {
        id: profile.id,
        name: profile.name,
        type: profile.type,
        username: profile.username,
        secretRef: profile.secretRef,
        port: profile.port,
        notes: profile.notes,
        lastRotatedAt: profile.lastRotatedAt?.toISOString() ?? null,
        deviceCount: 0,
      },
    },
    { correlationId },
    201
  );
}
