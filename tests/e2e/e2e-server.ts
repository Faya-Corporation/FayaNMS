/**
 * TEST-001-A — E2E journey harness.
 *
 * Boots the REAL production topology (no mocks) and drives it over plain
 * HTTP, exactly like an operator's browser or an API client would:
 *
 *   browser/client → Next.js app (production build, :3100)
 *                      → PostgreSQL (ephemeral fayanms_e2e database)
 *                      ← worker (:3030, poll-based job engine)
 *                      → simulator device plane
 *
 * Requirements to run:
 *   FAYANMS_E2E=1 bun test tests/e2e/          # after `bun run build:gate`
 *   (a PostgreSQL at DATABASE_URL with CREATEDB — the harness creates and
 *    destroys its own fayanms_e2e database; dev databases are untouched)
 *
 * The journeys stay UNLESS the flag is set (bun test tests/ skips them —
 * the unit gate must not depend on a built server), and CI's e2e job runs
 * them with the flag against service containers.
 */
import { randomBytes } from "node:crypto";
import { SQL } from "bun";

export const APP_PORT = 3100;
export const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
export const E2E_DB = "fayanms_e2e";
export const ADMIN_EMAIL = "admin@faya.local";
export const ADMIN_PASSWORD = "faya123";

/**
 * FRESH random secrets per e2e run — the deterministic CI fixture values are
 * deliberately REFUSED by the production startup policy (P1-019 known-bad
 * blocklist), and the e2e app boots in production. The app and worker share
 * the same legacy-plane secret (dual/legacy identity mode), which the
 * startup policy validates for strength, not provenance.
 */
const RUN_SECRET = randomBytes(32).toString("hex");

const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!DATABASE_URL.startsWith("postgres")) {
  throw new Error("[e2e] DATABASE_URL must be a postgres:// URL to clone the e2e database from");
}
const ADMIN_URL = new URL(DATABASE_URL);
ADMIN_URL.pathname = "/postgres";
const pgAdminUrl = ADMIN_URL.toString();
const e2eDbUrl = (() => {
  const u = new URL(DATABASE_URL);
  u.pathname = `/${E2E_DB}`;
  return u.toString();
})();

const appEnv: Record<string, string> = {
  NODE_ENV: "production",
  DATABASE_URL: e2eDbUrl,
  NEXTAUTH_URL: "http://localhost:3100",
  NEXTAUTH_SECRET: RUN_SECRET,
  FAYANMS_SERVICE_SECRET: RUN_SECRET,
  FAYANMS_CONFIG_ENC_KEY: RUN_SECRET,
  FAYANMS_CONFIG_ENC_KEY_ID: "k1",
  // The ambient dev .env carries FAYANMS_DEMO_MODE=true; the production
  // server must boot WITHOUT it (explicit empty override — the policy
  // refuses the literal "true").
  FAYANMS_DEMO_MODE: "",
  // Login-guard journey knobs (clamped minimums for a fast, deterministic
  // throttle + full recovery inside the journey itself).
  FAYANMS_LOGIN_WINDOW_SECONDS: "30",
  FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE: "5",
  FAYANMS_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT: "30",
  FAYANMS_TRUST_PROXY_HOPS: "1",
};

const childProcesses: ReturnType<typeof Bun.spawn>[] = [];

function spawnLogged(cmd: string[], env: Record<string, string>, label: string) {
  const logFile = `/tmp/fayanms-e2e-${label}.log`;
  const child = Bun.spawn(cmd, {
    env: { ...process.env, ...env },
    stdout: Bun.file(logFile),
    stderr: Bun.file(logFile),
  });
  childProcesses.push(child);
  void (async () => {
    const code = await child.exited;
    if (code !== 0) {
      console.error(`[e2e:${label}] exited ${code} — log: ${logFile}`);
    }
  })();
  return child;
}

async function createAndMigrateDatabase(): Promise<void> {
  const admin = new SQL(pgAdminUrl);
  await admin.unsafe(`DROP DATABASE IF EXISTS "${E2E_DB}"`);
  await admin.unsafe(`CREATE DATABASE "${E2E_DB}"`);
  await admin.close().catch(() => undefined);

  const migrate = Bun.spawnSync(["bunx", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: e2eDbUrl, NODE_ENV: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (migrate.exitCode !== 0) {
    throw new Error(`[e2e] migrate deploy failed:\n${new TextDecoder().decode(migrate.stderr).slice(-2000)}`);
  }

  // Demo seed (T7 path): the seed process runs NON-production with an
  // explicit FAYANMS_DEMO_MODE=true; the SERVER env stays clean (the startup
  // policy refuses demo mode in production).
  const seed = Bun.spawnSync(["bun", "prisma/seed.ts"], {
    env: { ...process.env, DATABASE_URL: e2eDbUrl, NODE_ENV: "", FAYANMS_DEMO_MODE: "true" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (seed.exitCode !== 0) {
    throw new Error(`[e2e] seed failed:\n${new TextDecoder().decode(seed.stderr).slice(-2000)}`);
  }
}

async function startStack(): Promise<void> {
  // The Next.js PRODUCTION build (build:gate output). The repo builds with
  // output:"standalone", so the boot entry is .next/standalone/server.js
  // (NOT `next start`, which warns and mis-serves against standalone).
  // API journeys need no static assets. Skipped entirely unless FAYANMS_E2E=1.
  spawnLogged(["bun", ".next/standalone/server.js"], {
    ...appEnv,
    PORT: String(APP_PORT),
    HOSTNAME: "127.0.0.1",
  }, "app");

  // The worker: real poll-based job engine on the legacy shared-secret
  // identity plane (a valid boot configuration; the same shape certify.ts
  // uses). It claims CHANGE_EXECUTE jobs so the change journey can complete.
  // The env is deliberately MINIMAL (SEC-ENV-001 modeled, not inherited):
  // only the worker zone's material — no NEXTAUTH/KEK/DB variables — so the
  // boot scope check stays silent and the harness practises what the
  // deployment templates preach.
  spawnLogged(["bun", "mini-services/worker/index.ts"], {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    NODE_ENV: "production",
    FAYANMS_SERVICE_SECRET: RUN_SECRET,
    NEXT_BASE_URL: `http://127.0.0.1:${APP_PORT}`,
  }, "worker");

  // Readiness: /api/v1/meta is public and outside the rate gate.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${APP_BASE}/api/v1/meta`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("[e2e] app server did not become ready in 120 s");
}

let booted = false;

/** Idempotent global boot (called from beforeAll in the journey file). */
export async function bootE2E(): Promise<void> {
  if (booted) return;
  await createAndMigrateDatabase();
  await startStack();
  booted = true;
}

export async function teardownE2E(): Promise<void> {
  for (const child of childProcesses.splice(0)) {
    child.kill();
  }
  try {
    const admin = new SQL(pgAdminUrl);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${E2E_DB}"`);
    await admin.close().catch(() => undefined);
  } catch {
    /* best effort */
  }
}

/* ─────────────────────────── journey HTTP kit ────────────────────────────── */

/** Minimal cookie jar (NextAuth double-submit CSRF + session cookies). */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  clearSession(): void {
    this.cookies.delete("next-auth.session-token");
    this.cookies.delete("__Secure-next-auth.session-token");
  }
}

export interface Envelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
  meta?: { requestId?: string; correlationId?: string };
}

/** JSON request through the jar; returns the raw response + parsed envelope. */
export async function call(
  jar: CookieJar,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; response: Response; body: Envelope }> {
  const response = await fetch(`${APP_BASE}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      cookie: jar.header(),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    redirect: "manual",
  });
  jar.absorb(response);
  let body: Envelope = { success: false };
  try {
    body = (await response.json()) as Envelope;
  } catch {
    /* empty / non-JSON (redirects) */
  }
  return { status: response.status, response, body };
}

/** NextAuth credentials sign-in (json=true → 200 {url} / 401 on failure). */
export async function credentialsLogin(
  jar: CookieJar,
  email: string,
  password: string
): Promise<{ status: number }> {
  const csrfRes = await fetch(`${APP_BASE}/api/auth/csrf`, {
    headers: { cookie: jar.header() },
  });
  jar.absorb(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const form = new URLSearchParams({
    csrfToken,
    email,
    password,
    json: "true",
  });
  const res = await fetch(`${APP_BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: jar.header(),
    },
    body: form.toString(),
    redirect: "manual",
  });
  jar.absorb(res);
  await res.text().catch(() => "");
  return { status: res.status };
}

/** Full admin session (login + return the jar); asserts success. */
export async function loginAdmin(): Promise<CookieJar> {
  const jar = new CookieJar();
  const { status } = await credentialsLogin(jar, ADMIN_EMAIL, ADMIN_PASSWORD);
  if (status !== 200) throw new Error(`[e2e] admin login failed with ${status}`);
  return jar;
}
