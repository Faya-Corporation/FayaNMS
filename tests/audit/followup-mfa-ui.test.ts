import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Follow-up wave — MFA settings-UI (F-034's documented "enrollment is
 * API-first" honest limitation, graduated by the settings-UI wave).
 *
 * Pins, all hermetic (no network / DB / browser):
 *   1. The `accountSecurity` dictionary namespace: complete balanced EN/AR
 *      deep parity, every leaf the view + hook reference resolves, and the
 *      `mfaErrorKey` ApiError-code table maps onto existing leaves only.
 *   2. The `toast.mfa` namespace (mutation feedback) + the header user-menu
 *      leaf + the nav registry label — present in BOTH locales.
 *   3. Source pins: the view is registered in the router, the registry
 *      carries the self-service entry (header-menu surface, not sidebar),
 *      the header menu and the command palette reach it, the icon contract
 *      is closed, and the navigation store's ViewKey union admits it.
 *   4. The api-client MFA family targets the real backend surfaces
 *      (POST /api/v1/me/mfa/enroll, POST /confirm, DELETE /api/v1/me/mfa)
 *      with the reveal-once recovery-codes contract in the types.
 *   5. The retotal: dictionary leaf count moved 3314 → 3385 → 3392 (GA-3) in BOTH locales
 *      (all prior retotal pins updated in the same commit); 3394 since GA-5;
 *      3395 since GA-4b.
 */

const REPO = join(import.meta.dir, "..", "..");
type Messages = Record<string, unknown>;

function readJson(rel: string): Messages {
  return JSON.parse(readFileSync(join(REPO, rel), "utf8")) as Messages;
}

function readRepo(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8");
}

function leaves(obj: unknown, prefix = "", acc: string[] = []): string[] {
  if (obj !== null && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Messages))
      leaves(value, prefix ? `${prefix}.${key}` : key, acc);
  } else acc.push(prefix);
  return acc;
}

function subtree(root: Messages, path: string): Messages {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return {};
    cur = (cur as Messages)[part];
  }
  return (cur ?? {}) as Messages;
}

const VIEW = "src/components/views/account-security-view.tsx";
const HOOK = "src/hooks/api/use-mfa.ts";

describe("followup-mfa-ui — accountSecurity dictionary", () => {
  test("namespace exists with deep EN/AR parity (identical leaf sets)", () => {
    const en = readJson("messages/en.json");
    const ar = readJson("messages/ar.json");
    const enLeaves = leaves(subtree(en, "accountSecurity"));
    const arLeaves = leaves(subtree(ar, "accountSecurity"));
    expect(enLeaves.length).toBeGreaterThan(50);
    expect(new Set(enLeaves)).toEqual(new Set(arLeaves));
  });

  test("every literal key the view and hook reference resolves in BOTH locales", () => {
    const en = readJson("messages/en.json");
    const ar = readJson("messages/ar.json");
    const src = readRepo(VIEW) + "\n" + readRepo(HOOK);
    const refs = new Set<string>();
    // t("key") / tToast("key") literals — the hook's mfaErrorKey returns
    // "errors.X" paths separately (covered by the next test).
    for (const match of src.matchAll(/\bt(?:Toast)?\("([a-zA-Z][a-zA-Z0-9.]*)"\)/g))
      refs.add(match[1]);
    expect(refs.size).toBeGreaterThan(40);
    // Namespace resolution: most refs render under `accountSecurity`, but
    // the toast subcomponent binds a shadowed `t` to `toast.mfa`, so a ref
    // resolves if EITHER namespace carries it (the toast leaf-set itself is
    // pinned exhaustively in the next test).
    const flatEn = flat(en);
    const flatAr = flat(ar);
    for (const ref of refs) {
      if (ref.startsWith("errors.")) {
        expect(flatEn[`accountSecurity.${ref}`] !== undefined, `en leaf missing: accountSecurity.${ref}`).toBe(true);
        expect(flatAr[`accountSecurity.${ref}`] !== undefined, `ar leaf missing: accountSecurity.${ref}`).toBe(true);
        continue;
      }
      const enOk = flatEn[`accountSecurity.${ref}`] !== undefined || flatEn[`toast.mfa.${ref}`] !== undefined;
      const arOk = flatAr[`accountSecurity.${ref}`] !== undefined || flatAr[`toast.mfa.${ref}`] !== undefined;
      expect(enOk, `en leaf missing for ref: ${ref}`).toBe(true);
      expect(arOk, `ar leaf missing for ref: ${ref}`).toBe(true);
    }
  });

  test("mfaErrorKey's ApiError code table maps to existing errors.* leaves", () => {
    const en = readJson("messages/en.json");
    const ar = readJson("messages/ar.json");
    const hook = readRepo(HOOK);
    const codes = [...hook.matchAll(/case "([A-Z_]+)":/g)].map((m) => m[1]);
    // The typed surface: every MFA_* / RBAC / auth / body code the hook
    // names must map to an accountSecurity.errors.* leaf (directly or via
    // the documented aliases: MFA_CODE_REPLAYED→MFA_CODE_INVALID,
    // ACCOUNT_DISABLED→UNAUTHENTICATED, NETWORK_ERROR→network).
    const expected = [
      "MFA_DISABLED", "MFA_ALREADY_ENABLED", "MFA_NOT_ENROLLED", "MFA_CODE_REQUIRED",
      "MFA_CODE_INVALID", "MFA_CODE_REPLAYED", "MFA_PASSWORD_INVALID", "RBAC_FORBIDDEN",
      "UNAUTHENTICATED", "ACCOUNT_DISABLED", "INVALID_BODY", "NETWORK_ERROR",
    ];
    for (const code of expected) expect(codes.includes(code), `hook switch missing ${code}`).toBe(true);
    const flatEn = flat(en);
    const flatAr = flat(ar);
    for (const leaf of [
      "MFA_DISABLED", "MFA_ALREADY_ENABLED", "MFA_NOT_ENROLLED", "MFA_CODE_REQUIRED",
      "MFA_CODE_INVALID", "MFA_PASSWORD_INVALID", "RBAC_FORBIDDEN", "UNAUTHENTICATED",
      "INVALID_BODY", "network", "fallback",
    ]) {
      const path = `accountSecurity.errors.${leaf}`;
      expect(flatEn[path] !== undefined, `en missing ${path}`).toBe(true);
      expect(flatAr[path] !== undefined, `ar missing ${path}`).toBe(true);
    }
  });

  test("toast.mfa namespace + header leaf + nav label exist in BOTH locales", () => {
    const en = readJson("messages/en.json");
    const ar = readJson("messages/ar.json");
    const toastLeaves = leaves(subtree(en, "toast.mfa"));
    expect(new Set(toastLeaves)).toEqual(new Set(leaves(subtree(ar, "toast.mfa"))));
    for (const leaf of [
      "activatedTitle", "activatedDescription", "copied", "copyFailed", "disabledTitle", "disabledDescription",
    ])
      expect(toastLeaves.includes(leaf), `toast.mfa.${leaf}`).toBe(true);
    expect(flat(en)["header.accountSecurity"]).toBeDefined();
    expect(flat(ar)["header.accountSecurity"]).toBeDefined();
    expect((subtree(en, "nav.items.account.security") as Messages).title).toBeDefined();
    expect((subtree(ar, "nav.items.account.security") as Messages).title).toBeDefined();
  });
});

describe("followup-mfa-ui — shell wiring source pins", () => {
  test("view-router renders AccountSecurityView for account.security", () => {
    const router = readRepo("src/components/shell/view-router.tsx");
    expect(router).toContain('import { AccountSecurityView } from "@/components/views/account-security-view"');
    expect(router).toContain('case "account.security":');
    expect(router.indexOf('case "account.security":')).toBeLessThan(router.indexOf("return <AccountSecurityView />"));
  });

  test("navigation registry carries the self-service entry with the nav label", () => {
    const registry = readRepo("src/lib/navigation/registry.ts");
    expect(registry).toContain('"account.security":');
    expect(registry).toContain('labelKey: "nav.items.account.security"');
    // The self-service surface is a header-menu entry, NOT a sidebar module —
    // the registry comment documents the boundary (wraps across two lines).
    expect(registry).toContain("Self-service surface (F-034 follow-up)");
    expect(/opened from the header user\s*\n\s*\/\/ menu, NOT the sidebar/.test(registry)).toBe(true);
  });

  test("header user menu reaches the view; command palette keeps it keyboard-reachable", () => {
    const header = readRepo("src/components/shell/app-header.tsx");
    expect(header).toContain('setActiveView("account.security")');
    expect(header).toContain('tHeader("accountSecurity")');
    const palette = readRepo("src/components/shell/command-palette.tsx");
    expect(palette).toContain('{ view: "account.security", icon: ShieldCheck }');
  });

  test("icon contract and ViewKey union admit the new view", () => {
    const icons = readRepo("src/lib/icons/navigation-icons.ts");
    expect(icons).toContain('"account.security": fayanms(');
    const store = readRepo("src/stores/navigation.ts");
    expect(store).toContain('| "account.security"');
  });
});

describe("followup-mfa-ui — api-client MFA family", () => {
  const CLIENT = "src/lib/api-client.ts";

  test("surfaces target the real backend routes with the right methods", () => {
    const src = readRepo(CLIENT);
    expect(src).toContain('apiFetch<MfaEnrollResult>("/api/v1/me/mfa/enroll", {\n    method: "POST"');
    expect(src).toContain('apiFetch<MfaConfirmResult>("/api/v1/me/mfa/confirm", {\n    method: "POST"');
    expect(src).toContain('apiFetch<MfaDisableResult>("/api/v1/me/mfa", {\n    method: "DELETE"');
  });

  test("reveal-once contract is typed: confirm returns the plaintext recovery codes", () => {
    const src = readRepo(CLIENT);
    expect(src).toContain("recoveryCodes: string[]");
    expect(src).toContain("TEN single-use plaintext codes");
  });

  test("the status derivation honesty note is pinned (no GET status surface)", () => {
    const src = readRepo(CLIENT);
    expect(src).toContain("exposes NO GET status surface");
    expect(src).toContain("409 MFA_ALREADY_ENABLED");
  });
});

describe("followup-mfa-ui — retotal", () => {
  test("dictionary totals moved 3314 → 3385 → 3392 (GA-3) → 3394 (GA-5) → 3395 (GA-4b) in BOTH locales", () => {
    const en = leaves(readJson("messages/en.json"));
    const ar = leaves(readJson("messages/ar.json"));
    expect(en.length).toBe(3395);
    expect(ar.length).toBe(3395);
  });
});

/** Flatten a messages tree into dotted-key → value (order-independent). */
function flat(obj: unknown, prefix = "", acc: Record<string, unknown> = {}): Record<string, unknown> {
  if (obj !== null && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Messages))
      flat(value, prefix ? `${prefix}.${key}` : key, acc);
  } else acc[prefix] = obj;
  return acc;
}
