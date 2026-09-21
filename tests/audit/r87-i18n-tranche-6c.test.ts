import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R87 — i18n tranche 6c: admin-credentials keyed (the whole view — it has
 * no pre-existing namespace).
 *
 * Pins:
 *   A. NEW `credentials` namespace — EXACTLY 39 leaves per locale, deep
 *      parity (identical leaf-path sets both directions) and non-empty
 *      string values everywhere; dictionary totals move 1,851 → 1,890
 *      = 1,890.
 *   B. The view consumes the namespace through TWO `useTranslations
 *      ("credentials")` hooks (AdminCredentialsView + ProfileRow — the
 *      R84 multi-scope precedent).
 *   C. Sweep candidates: admin-credentials-view.tsx is at ZERO (26 → 0;
 *      the ledger ceiling was matched exactly at 26: 16 PROP + 10 JSX).
 *   D. Source pins: the pre-tranche literals are GONE from the file
 *      (each individually asserted absent), the keyed call sites are IN,
 *      and the dynamic-key resolution is pinned (AUTH_KEYS map with
 *      raw-token fallback — CredentialProfileRow.type is an open string,
 *      R86 KIND_KEYS / R84 STATUS_GROUPS / R82 SORT_CHIPS precedent).
 *      SNMPv3/HTTPS stay in the map: the pre-tranche EN chip rendered
 *      "SNMPv3", NOT the raw SNMPV3 token, so dropping them would be a
 *      visible EN regression.
 *   E. Ledger governance: the r56 sweep no longer ledgers
 *      admin-credentials-view, the numeric ledger carries EXACTLY 15
 *      entries, and the LIVE candidate sum over the ledgered files is
 *      EXACTLY 574 (computed from the tree, not quoted).
 *   F. Shape: every credentials leaf is a static string EXCEPT row.ref
 *      ("ref: {ref}") and row.devices (ICU plural — en one/other; ar
 *      zero/one/two/few/many/other, R84 row.counts precedent); the view
 *      title is nav-verbatim in both locales (بيانات الاعتماد); the
 *      breadcrumb reuses the established الإدارة/بيانات الاعتماد terms;
 *      row.never reuses the established أبدًا term (R86).
 *   G. Documented survivors stay in source: the •••••••• SECRET_MASK
 *      bullet token (secrets are never rendered in ANY locale — Gate
 *      G7), the vault:// technical reference inside the split notice
 *      body, date-fns formatDistanceToNow English relative time at BOTH
 *      call sites (no ar locale wired anywhere — device-config-tab /
 *      R83-R86 precedent), the em-dash loading/empty placeholders, and
 *      the data-plane row values (name/username/port/notes +
 *      title={notes}).
 */

const REPO = join(import.meta.dir, "..", "..");
const VIEWS = "src/components/views";
const VIEW = "admin-credentials-view.tsx";

const PROP_RE = /\b(title|placeholder|aria-label|label|description|heading)="([A-Z][^"]{2,})"/g;
const JSX_RE = />\s*([A-Z][a-zA-Z0-9 ,.·…—''-]{2,70})\s*</g;

type Messages = Record<string, unknown>;

function leaves(obj: unknown, prefix = "", acc: string[] = []): string[] {
  if (obj !== null && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Messages)) {
      leaves(value, prefix ? `${prefix}.${key}` : key, acc);
    }
  } else {
    acc.push(prefix);
  }
  return acc;
}

function readJson(rel: string): Messages {
  return JSON.parse(readFileSync(join(REPO, rel), "utf8")) as Messages;
}

function readRepo(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8");
}

function candidates(src: string): string[] {
  return [
    ...[...src.matchAll(PROP_RE)].map((m) => m[2]),
    ...[...src.matchAll(JSX_RE)].map((m) => m[1]),
  ];
}

describe("R87 — namespace is balanced", () => {
  test("A: credentials exists with EXACTLY 39 leaves per locale", () => {
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const json = readJson(file) as Record<string, Messages>;
      expect(json.credentials, `${file} credentials`).toBeDefined();
      expect(leaves(json.credentials).length, `${file} credentials leaves`).toBe(39);
    }
  });

  test("A: dictionary totals are 1,890 = 1,890 (1,851 + 39)", () => {
    const en = readJson("messages/en.json");
    const ar = readJson("messages/ar.json");
    expect(leaves(en).length).toBe(1890);
    expect(leaves(ar).length).toBe(1890);
  });

  test("A: deep parity — identical leaf paths in BOTH directions", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    const enSet = new Set(leaves(en.credentials));
    const arSet = new Set(leaves(ar.credentials));
    expect(Array.from(enSet).filter((k) => !arSet.has(k)), "en-only").toEqual([]);
    expect(Array.from(arSet).filter((k) => !enSet.has(k)), "ar-only").toEqual([]);
  });

  test("A: every credentials leaf value is a non-empty string in both locales", () => {
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const json = readJson(file) as Record<string, Messages>;
      const walk = (node: unknown, path: string) => {
        if (node !== null && typeof node === "object") {
          for (const [k, v] of Object.entries(node as Messages)) {
            walk(v, `${path}.${k}`);
          }
          return;
        }
        expect(typeof node === "string" && node.length > 0, `${file}:${path}`).toBe(true);
      };
      walk(json.credentials, "credentials");
    }
  });
});

describe("R87 — namespace consumption", () => {
  test("B: the view takes TWO useTranslations(\"credentials\") hooks (view + ProfileRow)", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    const hooks = Array.from(src.matchAll(/useTranslations\("credentials"\)/g)).length;
    expect(hooks).toBe(2);
    expect(src).toContain('const t = useTranslations("credentials");');
  });
});

describe("R87 — zero sweep candidates + full-inventory keying", () => {
  test("C: admin-credentials-view has ZERO literal candidates (26 → 0)", () => {
    const found = candidates(readRepo(`${VIEWS}/${VIEW}`));
    expect(found).toEqual([]);
  });

  test("D: the pre-tranche literals are GONE from the file", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    for (const gone of [
      'title="Credential Profiles"',
      'description="Vault-backed device credentials',
      'description="Profiles across all auth methods"',
      'label="Credential profiles"',
      'description="Password and key-based CLI access"',
      'label="SSH profiles"',
      'description="API_TOKEN and HTTPS integrations"',
      'label="API tokens"',
      'description="Most recent secret rotation across the vault"',
      'label="Last rotation"',
      'title="Profiles"',
      'description="Auth methods, ownership and rotation history',
      'title="Could not load credential profiles"',
      'description="Credential profiles are provisioned with the vault',
      'title="No credential profiles yet"',
      'aria-label="Credential vault',
      ">Secrets are always masked<",
      ">Name<",
      ">Auth method<",
      ">Username<",
      ">Secret<",
      ">Port<",
      ">Devices<",
      ">Last rotated<",
      ">Notes<",
      ">Vault-managed — secrets are never displayed",
      "{ label: \"Administration\" }",
      '{ label: "Credential Profiles" }',
      "AUTH_METHOD_LABEL",
      ': "SSH password"',
      ': "SSH key"',
      ': "API token"',
      "The credential list could not be loaded.",
      ': "Never";',
      "device${profile.deviceCount === 1",
      "ref: {profile.secretRef}",
    ]) {
      expect(src.includes(gone), `must be gone: ${gone}`).toBe(false);
    }
  });

  test("D: the keyed call sites are IN (incl. the non-swept notice split + reason fallback)", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    for (const key of [
      't("breadcrumb.administration")',
      't("breadcrumb.credentials")',
      'title={t("title")}',
      'description={t("description")}',
      't("kpi.total.label")',
      't("kpi.total.description")',
      't("kpi.ssh.label")',
      't("kpi.ssh.description")',
      't("kpi.tokens.label")',
      't("kpi.tokens.description")',
      't("kpi.rotation.label")',
      't("kpi.rotation.description")',
      't("notice.title")',
      't("notice.bodyStart")',
      't("notice.bodyEnd")',
      't("card.title")',
      't("card.description")',
      't("error.title")',
      ': t("error.reasonFallback")',
      't("empty.title")',
      't("empty.description")',
      'aria-label={t("table.ariaLabel")}',
      't("table.col.name")',
      't("table.col.authMethod")',
      't("table.col.username")',
      't("table.col.secret")',
      't("table.col.port")',
      't("table.col.devices")',
      't("table.col.lastRotated")',
      't("table.col.notes")',
      't("row.never")',
      't("row.vaultManaged")',
      't("row.ref", { ref: profile.secretRef })',
      't("row.devices", { count: profile.deviceCount })',
    ]) {
      expect(src.includes(key), `must exist: ${key}`).toBe(true);
    }
  });

  test("D: dynamic-key resolution with raw-token fallback (open API contract)", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    for (const key of [
      "const AUTH_KEYS: Record<string, string> = {",
      'SSH_PASSWORD: "sshPassword",',
      'SSH_KEY: "sshKey",',
      'API_TOKEN: "apiToken",',
      'SNMPV3: "snmpv3",',
      'HTTPS: "https",',
      "const authKey = AUTH_KEYS[profile.type];",
      "authKey ? t(`authMethod.${authKey}`) : profile.type",
    ]) {
      expect(src.includes(key), `must exist: ${key}`).toBe(true);
    }
  });
});

describe("R87 — ledger governance", () => {
  test("E: the r56 ledger no longer lists admin-credentials-view", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    expect(/"admin-credentials-view\.tsx":\s*\d/.test(sweep)).toBe(false);
  });

  test("E: the numeric ledger carries EXACTLY 15 entries (16 − 1, R87)", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    const entries = Array.from(block.matchAll(/"([a-z-]+-view\.tsx)":\s*(\d+)/g));
    expect(entries.length).toBe(15);
  });

  test("E: the LIVE candidate sum over ledgered files is EXACTLY 574 (600 − 26, R87)", () => {
    const sweep = readRepo("tests/audit/r56-i18n-chrome-sweep.test.ts");
    const block = sweep.slice(sweep.indexOf("const PENDING_VIEWS"));
    const entries = Array.from(block.matchAll(/"([a-z-]+-view\.tsx)":\s*(\d+)/g));
    let sum = 0;
    for (const [, file] of entries) {
      sum += candidates(readRepo(`${VIEWS}/${file}`)).length;
    }
    expect(sum).toBe(574);
  });
});

describe("R87 — value shapes and term consistency", () => {
  test("F: every credentials leaf is static EXCEPT row.ref and row.devices", () => {
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const json = readJson(file) as Record<string, Messages>;
      const cred = json.credentials as Messages;
      const walk = (node: unknown, path: string) => {
        if (node !== null && typeof node === "object") {
          for (const [k, v] of Object.entries(node as Messages)) {
            walk(v, `${path}.${k}`);
          }
          return;
        }
        if (path === "credentials.row.ref" || path === "credentials.row.devices") return;
        expect(
          typeof node === "string" && !node.includes("{") && !node.includes("}"),
          `${file}:${path} must be static`
        ).toBe(true);
      };
      walk(cred, "credentials");
    }
  });

  test("F: row.ref placeholder shape in both locales", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    expect(((en.credentials as Messages).row as Messages).ref).toBe("ref: {ref}");
    expect(((ar.credentials as Messages).row as Messages).ref).toBe("المرجع: {ref}");
  });

  test("F: row.devices ICU plural — en one/other; ar zero/one/two/few/many/other", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    const enPlural = ((en.credentials as Messages).row as Messages).devices as string;
    const arPlural = ((ar.credentials as Messages).row as Messages).devices as string;
    expect(enPlural).toContain("{count, plural,");
    for (const category of ["one {", "other {"]) {
      expect(enPlural, `en plural missing ${category}`).toContain(category);
    }
    expect(enPlural).not.toContain("zero {");
    expect(arPlural).toContain("{count, plural,");
    for (const category of ["zero {", "one {", "two {", "few {", "many {", "other {"]) {
      expect(arPlural, `ar plural missing ${category}`).toContain(category);
    }
  });

  test("F: the title is nav-verbatim in BOTH locales (بيانات الاعتماد)", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    const enNav = ((en.nav as Messages).items as Messages) as Messages;
    const arNav = ((ar.nav as Messages).items as Messages) as Messages;
    const enCred = en.credentials as Messages;
    const arCred = ar.credentials as Messages;
    const enNavCred = (((enNav.admin as Messages).credentials as Messages).title) as string;
    const arNavCred = (((arNav.admin as Messages).credentials as Messages).title) as string;
    expect(enCred.title).toBe(enNavCred);
    expect(arCred.title).toBe(arNavCred);
    expect(arCred.title).toBe("بيانات الاعتماد");
  });

  test("F: the breadcrumb reuses the established nav terms in BOTH locales", () => {
    const en = readJson("messages/en.json") as Record<string, Messages>;
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    const enCred = en.credentials as Messages;
    const arCred = ar.credentials as Messages;
    const enBc = enCred.breadcrumb as Messages;
    const arBc = arCred.breadcrumb as Messages;
    expect(enBc.administration).toBe("Administration");
    expect(arBc.administration).toBe("الإدارة");
    expect(((ar.nav as Messages).groups as Messages).administration).toBe("الإدارة");
    // The second crumb mirrors the (nav-verbatim) title.
    expect(enBc.credentials).toBe(enCred.title);
    expect(arBc.credentials).toBe(arCred.title);
  });

  test("F: row.never reuses the established AR أبدًا term (R86)", () => {
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    const cred = ((ar.credentials as Messages).row as Messages).never;
    const collectors = ((((ar.collectors as Messages).registry as Messages).row as Messages).never) as string;
    expect(cred).toBe("أبدًا");
    expect(cred).toBe(collectors);
  });

  test("G: SNMPv3/HTTPS stay Latin protocol names in BOTH locales", () => {
    for (const file of ["messages/en.json", "messages/ar.json"]) {
      const json = readJson(file) as Record<string, Messages>;
      const auth = (json.credentials as Messages).authMethod as Messages;
      expect(auth.snmpv3, `${file} snmpv3`).toBe("SNMPv3");
      expect(auth.https, `${file} https`).toBe("HTTPS");
    }
  });

  test("G: the AR tokens KPI description keeps API_TOKEN Latin (OFFLINE precedent)", () => {
    const ar = readJson("messages/ar.json") as Record<string, Messages>;
    const tokens = ((ar.credentials as Messages).kpi as Messages).tokens as Messages;
    expect(tokens.description as string).toContain("API_TOKEN");
    expect(tokens.description as string).toContain("HTTPS");
  });

  test("G: documented data-plane survivors stay in source", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    expect(src).toContain('const SECRET_MASK = "••••••••";');
    expect(src).toContain("{SECRET_MASK}");
    expect(src).toContain('<code className="font-mono text-xs">vault://…</code>');
    expect(src).toContain("formatDistanceToNow(kpis.lastRotated, { addSuffix: true })");
    expect(src).toContain("formatDistanceToNow(parseISO(profile.lastRotatedAt), { addSuffix: true })");
    expect(src).toContain('value={credentialsQuery.isLoading ? "—" : kpis.total}');
    expect(src).toContain("title={profile.notes}");
    expect(src).toContain("{profile.username}");
    expect(src).toContain("{profile.name}");
    expect(src).toContain("{profile.port}");
    expect(src).toContain("{ ref: profile.secretRef }");
  });

  test("G: date-fns stays English (no ar locale wired)", () => {
    const src = readRepo(`${VIEWS}/${VIEW}`);
    expect(src).toContain('import { formatDistanceToNow, parseISO } from "date-fns";');
    expect(src).not.toMatch(/from "date-fns\/locale/);
  });
});
