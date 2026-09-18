import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R52 — Full End-to-End Production ReAudit (2026-09-18) remediation pins.
 *
 * The re-audit of z_ai_v2 @ 1c6ab0c produced one actionable code finding
 * (F-N1, P3) plus hygiene findings. This suite pins every remediation so
 * the ordering/hygiene invariants cannot silently regress:
 *
 *   - R52-F-N1: the three AI routes resolved the ACTOR only AFTER building
 *     their DB context — a half-authenticated principal (deactivated user
 *     with a live JWT, or an opaque-bearer API client admitted on the
 *     mutation plane) got a 404-vs-401 existence oracle plus free pre-auth
 *     DB work. The actor gate now precedes ALL DB work on every AI route.
 *   - R52-H1: the dead `credentials-view.tsx` component (imported nowhere;
 *     the router mounts AdminCredentialsView) is gone.
 *   - R52-H2: nine unused runtime dependencies removed; the socket.io pair
 *     (used only by the tracked examples/websocket scaffold) demoted to
 *     devDependencies.
 *   - R52-H3: the schema's "NO Prisma Json type" portability rule now
 *     documents its single sanctioned exception (LoginGuardState.failures),
 *     and that exception is the ONLY Json column in the schema.
 */

const REPO = join(import.meta.dir, "..", "..");

function readRepo(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8");
}

/** Index of the FIRST match, or -1 (mirrors String#indexOf semantics). */
function indexOfFirst(source: string, marker: string): number {
  return source.indexOf(marker);
}

describe("R52-F-N1 — AI routes resolve the actor BEFORE any DB work", () => {
  const cases: { file: string; dbMarker: string; label: string }[] = [
    {
      file: "src/app/api/v1/ai/assist/route.ts",
      dbMarker: "buildDeviceContext(id)",
      label: "ai/assist hoists resolveActingUser above the context build",
    },
    {
      file: "src/app/api/v1/ai/change-draft/route.ts",
      dbMarker: "db.device.findMany",
      label: "ai/change-draft hoists resolveActingUser above the inventory snapshot",
    },
    {
      file: "src/app/api/v1/ai/rca-draft/route.ts",
      dbMarker: "db.incident.findUnique",
      label: "ai/rca-draft hoists resolveActingUser above the incident lookup",
    },
  ];

  for (const { file, dbMarker, label } of cases) {
    test(label, () => {
      const source = readRepo(file);
      const actorAt = indexOfFirst(source, "resolveActingUser(request)");
      const dbAt = indexOfFirst(source, dbMarker);
      expect(actorAt).toBeGreaterThan(-1);
      expect(dbAt).toBeGreaterThan(-1);
      // The auth gate MUST precede the first DB touch — a 401, never a
      // 404-vs-401 oracle or pre-auth context work.
      expect(actorAt).toBeLessThan(dbAt);
    });
  }

  test("every AI route resolves the actor exactly once (no double-gate drift)", () => {
    for (const route of ["assist", "change-draft", "rca-draft", "query"]) {
      const source = readRepo(`src/app/api/v1/ai/${route}/route.ts`);
      const matches = source.match(/resolveActingUser\(request\)/g) ?? [];
      expect(matches.length).toBe(1);
    }
  });

  test("ai/query keeps its correct ordering too (regression guard)", () => {
    const source = readRepo("src/app/api/v1/ai/query/route.ts");
    // ai/query's data sweeps live in handler-EXTERNAL helpers (file top
    // half); its POST handler (:689+) gates the actor before its own first
    // DB touch. Pin WITHIN the POST handler slice so the helper positions
    // cannot produce a false comparison.
    const postAt = indexOfFirst(source, "export async function POST");
    expect(postAt).toBeGreaterThan(-1);
    const post = source.slice(postAt);
    const actorAt = post.indexOf("resolveActingUser(request)");
    const firstDbAt = post.indexOf("db.site.findMany");
    expect(actorAt).toBeGreaterThan(-1);
    expect(firstDbAt).toBeGreaterThan(-1);
    expect(actorAt).toBeLessThan(firstDbAt);
  });
});

describe("R52-H1 — dead view removed", () => {
  test("credentials-view.tsx no longer exists and nothing references it", () => {
    expect(existsSync(join(REPO, "src/components/views/credentials-view.tsx"))).toBe(false);
    // The router keeps mounting the admin variant only.
    const router = readRepo("src/components/shell/view-router.tsx");
    expect(router).toContain("AdminCredentialsView");
    expect(router).not.toContain('from "@/components/views/credentials-view"');
  });
});

describe("R52-H2 — runtime dependency surface shrunk", () => {
  const REMOVED = [
    "@dnd-kit/core",
    "@dnd-kit/sortable",
    "@dnd-kit/utilities",
    "@mdxeditor/editor",
    "@reactuses/core",
    "@tanstack/react-table",
    "react-markdown",
    "react-syntax-highlighter",
    "uuid",
  ];

  test("the nine unused packages are gone from package.json dependencies", () => {
    const pkg = JSON.parse(readRepo("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const dep of REMOVED) {
      expect(pkg.dependencies[dep]).toBeUndefined();
      expect(pkg.devDependencies[dep]).toBeUndefined();
    }
  });

  test("the socket.io pair lives in devDependencies only (examples-only scaffold)", () => {
    const pkg = JSON.parse(readRepo("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies["socket.io"]).toBeDefined();
    expect(pkg.devDependencies["socket.io-client"]).toBeDefined();
    expect(pkg.dependencies["socket.io"]).toBeUndefined();
    expect(pkg.dependencies["socket.io-client"]).toBeUndefined();
  });
});

describe("R52-H3 — schema Json-rule discipline is explicit", () => {
  test("LoginGuardState.failures is the ONLY Prisma Json column", () => {
    const schema = readRepo("prisma/schema.prisma");
    const jsonColumns = schema
      .split("\n")
      .filter((line) => /\sJson\b/.test(line) && !line.trim().startsWith("//"));
    expect(jsonColumns.length).toBe(1);
    expect(jsonColumns[0]).toContain("failures");
  });

  test("the schema header documents the sanctioned exception (governance note)", () => {
    const schema = readRepo("prisma/schema.prisma");
    expect(schema).toContain("SINGLE SANCTIONED EXCEPTION");
    expect(schema).toContain("LoginGuardState.failures");
  });
});
