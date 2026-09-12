/**
 * Phase 19-C (audit AUTHZ-101) — sync the LIVE database Role rows to
 * src/lib/auth/role-matrix.ts WITHOUT a reseed (demo data is preserved).
 *
 * Only Role.permissionsJson/description rows are upserted. Users, devices,
 * changes, snapshots etc. are untouched. Run: bun scripts/sync-role-permissions.ts
 */
import { PrismaClient } from "@prisma/client";

import { ROLE_MATRIX } from "../src/lib/auth/role-matrix";

const db = new PrismaClient();

async function main(): Promise<void> {
  for (const role of ROLE_MATRIX) {
    const permissionsJson = JSON.stringify(role.permissions);
    const existing = await db.role.findUnique({ where: { name: role.name } });
    if (!existing) {
      await db.role.create({
        data: {
          id: role.id,
          name: role.name,
          description: role.description,
          permissionsJson,
        },
      });
      console.log(`created role ${role.name} (${role.permissions.length} permissions)`);
    } else if (existing.permissionsJson !== permissionsJson) {
      await db.role.update({
        where: { name: role.name },
        data: { permissionsJson, description: role.description },
      });
      console.log(`updated role ${role.name} (${role.permissions.length} permissions)`);
    } else {
      console.log(`role ${role.name} already up to date`);
    }
  }
  console.log("role matrix sync complete");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
