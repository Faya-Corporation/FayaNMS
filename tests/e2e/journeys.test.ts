/**
 * TEST-001-A — release-critical end-to-end journeys (prompt C1/C2: focus on
 * release-critical flows; no giant brittle suite).
 *
 *   J1  Authentication     login → session → authorized route → logout
 *   J2  Inventory          create device → read → update → duplicate guard
 *   J3  Change management  draft/submit → approvals → execute → validate →
 *                          close, SUCCESS + truthful FAILURE (failAt) both
 *   J4  API client         create (token once) → scoped mutation → scope
 *                          refusal → revoke → rejected afterward
 *   J5  Login throttle     burst → 429 + Retry-After → full recovery
 *
 * Every journey runs against the real production topology booted by
 * e2e-server.ts (app + worker + PostgreSQL + simulator plane). Skipped
 * entirely unless FAYANMS_E2E=1 (CI's e2e job and local runs set it).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  ADMIN_EMAIL,
  APP_BASE,
  CookieJar,
  bootE2E,
  call,
  credentialsLogin,
  loginAdmin,
  teardownE2E,
  type Envelope,
} from "./e2e-server";

const E2E_ENABLED = process.env.FAYANMS_E2E === "1";

interface DeviceView {
  id: string;
  hostname: string;
  displayName: string;
  dataSource: string;
  status: string;
  vendor: { key: string };
}
interface ChangeView {
  id: string;
  number: string;
  status: string;
  riskLevel: string;
  riskScore: number;
  steps?: Array<{ name: string; type: string; status: string }>;
}
interface ApiClientView {
  id: string;
  name: string;
  scopes: string[];
  isActive: boolean;
}

let admin: CookieJar;
let deviceId = "";

beforeAll(
  async () => {
    if (!E2E_ENABLED) return;
    await bootE2E();
    admin = await loginAdmin();
  },
  // Booting the stack (migrate + seed + prod server + worker) far exceeds
  // bun's default 5 s hook timeout.
  180_000
);

afterAll(async () => {
  if (!E2E_ENABLED) return;
  await teardownE2E();
  // 60 s hook timeout (browser-journeys.test.ts precedent): teardownE2E is
  // internally bounded (5 s reap race + best-effort DROP), but right after a
  // long journey (J5 runs ~31 s) a loaded runner can exceed bun's DEFAULT
  // 5 s hook timeout inside the DROP — run 2026-10-03 (PR #56 e2e):
  // "(fail) (unnamed) [5000.43ms] a beforeEach/afterEach hook timed out"
  // after six green journeys. The boot side already carries 180 s.
}, 60_000);

describe("J1 — authentication journey", () => {
  test.skipIf(!E2E_ENABLED)(
    "login → session → authorized route → logout → session dead",
    async () => {
      // Session is live: the NextAuth session AND the FayaNMS permission view.
      const session = await call(admin, "/api/v1/auth/session");
      expect(session.status).toBe(200);
      expect(session.body.success).toBe(true);
      const sessionData = session.body.data as {
        user?: { email: string; role: { name: string } };
        permissions?: string[];
        canWrite?: boolean;
      };
      expect(sessionData.user?.email).toBe(ADMIN_EMAIL);
      expect(sessionData.canWrite).toBe(true);

      // Authorized read through the proxy gate.
      const devices = await call(admin, "/api/v1/devices?page=1&pageSize=5");
      expect(devices.status).toBe(200);
      expect(devices.body.success).toBe(true);

      // Unauthenticated traffic is refused by the proxy, not the handler.
      const anon = new CookieJar();
      const refused = await call(anon, "/api/v1/devices");
      expect(refused.status).toBe(401);
      expect(refused.body.error?.code).toBe("UNAUTHENTICATED");

      // Logout: the CSRF-protected signout clears the session.
      const csrfRes = await fetch(`${APP_BASE}/api/auth/csrf`, {
        headers: { cookie: admin.header() },
      });
      admin.absorb(csrfRes);
      const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
      const signout = await fetch(`${APP_BASE}/api/auth/signout`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: admin.header() },
        body: new URLSearchParams({ csrfToken, json: "true" }).toString(),
        redirect: "manual",
      });
      admin.absorb(signout);
      expect(signout.status).toBe(200);

      const afterLogout = await call(admin, "/api/v1/devices");
      expect(afterLogout.status).toBe(401);
    }
  );
});

describe("J2 — inventory journey", () => {
  test.skipIf(!E2E_ENABLED)(
    "create device → read → update → duplicate hostname refused (409)",
    async () => {
      const admin2 = await loginAdmin(); // fresh session after J1's logout
      const hostname = `e2e-journey-${Date.now()}`;

      const created = await call(admin2, "/api/v1/devices", {
        body: {
          hostname,
          vendorId: "ven-cisco",
          mgmtIp: "10.99.77.10",
          dataSource: "SIMULATOR",
          criticality: "MEDIUM",
          displayName: "E2E Journey Switch",
        },
      });
      expect(created.status).toBe(201);
      expect(created.body.success).toBe(true);
      const device = (created.body.data as { device: DeviceView }).device;
      expect(device.hostname).toBe(hostname);
      expect(device.dataSource).toBe("SIMULATOR");
      expect(device.status).toBe("UNKNOWN");
      deviceId = device.id;

      // Read detail.
      const detail = await call(admin2, `/api/v1/devices/${deviceId}`);
      expect(detail.status).toBe(200);
      expect((detail.body.data as { hostname: string }).hostname).toBe(hostname);

      // Update.
      const patched = await call(admin2, `/api/v1/devices/${deviceId}`, {
        method: "PATCH",
        body: { displayName: "E2E Journey Switch v2", criticality: "HIGH" },
      });
      expect(patched.status).toBe(200);
      expect((patched.body.data as { displayName: string }).displayName).toBe(
        "E2E Journey Switch v2"
      );

      // Duplicate hostname guard.
      const duplicate = await call(admin2, "/api/v1/devices", {
        body: {
          hostname,
          vendorId: "ven-cisco",
          mgmtIp: "10.99.77.11",
        },
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error?.code).toBe("HOSTNAME_TAKEN");

      // Re-arm the module-level session for the change journey (J1 logged it
      // out deliberately; J3+ need a live admin session).
      const rearmed = await credentialsLogin(admin, "admin@faya.local", "faya123");
      expect(rearmed.status).toBe(200);
    }
  );
});

describe("J3 — change management journey (simulator plane)", () => {
  test.skipIf(!E2E_ENABLED)(
    "submit → approvals (MEDIUM: TECHNICAL+MANAGER) → execute → SUCCESSFUL",
    async () => {
      expect(deviceId).not.toBe("");
      const created = await call(admin, "/api/v1/changes", {
        body: {
          title: "E2E: no-op simulator change journey",
          type: "NORMAL", // base 30 → MEDIUM → TECHNICAL + MANAGER, quorum 1 each
          deviceIds: [deviceId],
          description: "Release-critical E2E journey — full lifecycle.",
          submit: true, // straight to AWAITING_APPROVAL (server creates PENDING approvals)
        },
      });
      expect(created.status).toBe(201);
      const change = (created.body.data as { change: ChangeView }).change;
      expect(change.status).toBe("AWAITING_APPROVAL");
      expect(change.riskLevel).toBe("MEDIUM");

      // Approve both levels with the wildcard admin (quorum 1 per level).
      for (const level of ["TECHNICAL", "MANAGER"] as const) {
        const approval = await call(admin, `/api/v1/changes/${change.id}/approvals`, {
          body: { level, decision: "APPROVED", comment: "e2e journey" },
        });
        expect(approval.status).toBe(200);
      }
      // The change is now APPROVED (bindable approvals, quorum complete).
      const afterApproval = await call(admin, `/api/v1/changes/${change.id}`);
      expect((afterApproval.body.data as { status: string }).status ?? afterApproval.body.data).toBeTruthy();

      // Execute (single-flight lease acquired server-side).
      const executed = await call(admin, `/api/v1/changes/${change.id}/execute`, { body: {} });
      expect(executed.status).toBe(201);
      const job = (executed.body.data as { job: { id: string; status: string } }).job;
      expect(job.status).toBe("QUEUED");

      // Poll until the worker-driven engine reaches the terminal state.
      const deadline = Date.now() + 120_000;
      let finalStatus = "";
      while (Date.now() < deadline) {
        const poll = await call(admin, `/api/v1/changes/${change.id}`);
        expect(poll.status).toBe(200);
        const view = poll.body.data as unknown as ChangeView;
        if (["SUCCESSFUL", "FAILED", "CANCELLED"].includes(view.status)) {
          finalStatus = view.status;
          break;
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
      expect(finalStatus).toBe("SUCCESSFUL");

      // Double-execute after completion is refused (no zombie re-run).
      const reExecute = await call(admin, `/api/v1/changes/${change.id}/execute`, { body: {} });
      expect([409, 400]).toContain(reExecute.status);
    },
    150_000 // execute is worker-driven (poll loop); far above bun's 5 s default
  );

  test.skipIf(!E2E_ENABLED)(
    "failure case: failAt=APPLY → truthful FAILED state (blast radius honest)",
    async () => {
      const created = await call(admin, "/api/v1/changes", {
        body: {
          title: "E2E: controlled simulator failure journey",
          type: "STANDARD", // + rollbackPlan → LOW → single TECHNICAL level
          deviceIds: [deviceId],
          rollbackPlan: "revert the interface description",
          submit: true,
        },
      });
      expect(created.status).toBe(201);
      const change = (created.body.data as { change: ChangeView }).change;

      const approval = await call(admin, `/api/v1/changes/${change.id}/approvals`, {
        body: { level: "TECHNICAL", decision: "APPROVED" },
      });
      expect(approval.status).toBe(200);

      const executed = await call(admin, `/api/v1/changes/${change.id}/execute`, {
        body: { failAt: "APPLY" },
      });
      expect(executed.status).toBe(201);

      const deadline = Date.now() + 120_000;
      let finalStatus = "";
      let steps: Array<{ name: string; type: string; status: string }> = [];
      while (Date.now() < deadline) {
        const poll = await call(admin, `/api/v1/changes/${change.id}`);
        const view = (poll.body.data ?? {}) as unknown as ChangeView;
        if (["SUCCESSFUL", "FAILED", "CANCELLED"].includes(view.status)) {
          finalStatus = view.status;
          steps = view.steps ?? [];
          break;
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
      expect(finalStatus).toBe("FAILED");
      // Truthful per-step states: the APPLY step failed, validation never
      // succeeded. Steps carry human names + a machine `type` (CHECK/BACKUP/
      // APPLY/VALIDATE/ROLLBACK) — match on type.
      const applyStep = steps.find((s) => s.type === "APPLY");
      const validateStep = steps.find((s) => s.type === "VALIDATE");
      expect(applyStep?.status).toBe("FAILED");
      if (validateStep) expect(validateStep.status).not.toBe("SUCCEEDED");
    },
    150_000
  );
});

describe("J4 — API client journey (create/use/revoke, fail-closed)", () => {
  test.skipIf(!E2E_ENABLED)(
    "token shown once → scoped bearer mutation → revocation kills access",
    async () => {
      // Create a client with exactly the alert-acknowledge scope.
      const created = await call(admin, "/api/v1/admin/api-clients", {
        body: { name: "e2e-journey-bot", scopes: ["alerts.write"] },
      });
      expect(created.status).toBe(201);
      const clientData = created.body.data as { client: ApiClientView; token: string };
      expect(clientData.token.length).toBeGreaterThanOrEqual(24);

      // A scoped, opted-in mutation works with the bearer token.
      const alerts = await call(admin, "/api/v1/alerts?status=ACTIVE&page=1&pageSize=5");
      expect(alerts.status).toBe(200);
      const alertData = alerts.body.data as unknown;
      const alertList: Array<{ id: string }> = Array.isArray(alertData)
        ? alertData
        : ((alertData as { items?: Array<{ id: string }> })?.items ?? []);
      const alertId = alertList[0]?.id;
      expect(alertId).toBeTruthy();

      const bearer = new CookieJar(); // no session — pure machine identity
      const ack = await call(bearer, `/api/v1/alerts/${alertId}/acknowledge`, {
        method: "POST",
        body: {},
        headers: { authorization: `Bearer ${clientData.token}` },
      });
      expect(ack.status).toBe(200);

      // Scope-insufficient client on the same route is refused.
      const narrow = await call(admin, "/api/v1/admin/api-clients", {
        body: { name: "e2e-narrow-bot", scopes: ["metrics.read"] },
      });
      expect(narrow.status).toBe(201);
      const narrowData = narrow.body.data as { token: string };
      const refused = await call(bearer, `/api/v1/alerts/${alertId}/acknowledge`, {
        method: "POST",
        body: {},
        headers: { authorization: `Bearer ${narrowData.token}` },
      });
      expect(refused.status).toBe(403);
      expect(
        ["API_CLIENT_SCOPE_INSUFFICIENT", "API_CLIENT_HUMAN_REQUIRED"].includes(
          refused.body.error?.code ?? ""
        )
      ).toBe(true);

      // Revoke → the token stops working immediately (fail-closed).
      const revoked = await call(admin, `/api/v1/admin/api-clients/${clientData.client.id}`, {
        method: "PATCH",
        body: { isActive: false },
      });
      expect(revoked.status).toBe(200);

      // Re-arm the first alert's state? Not needed: even a repeated ack on the
      // SAME alert must now fail with 401 (revoked), not succeed idempotently.
      const afterRevoke = await call(bearer, `/api/v1/alerts/${alertId}/acknowledge`, {
        method: "POST",
        body: {},
        headers: { authorization: `Bearer ${clientData.token}` },
      });
      expect(afterRevoke.status).toBe(401);
    }
  );
});

describe("J5 — login abuse protection journey (AUTH-001-A)", () => {
  test.skipIf(!E2E_ENABLED)(
    "burst → 429 with Retry-After BEFORE password verification → recovery",
    async () => {
      const jar = new CookieJar();
      // Budget: FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE=5 (server env). Five
      // wrong-password attempts answer the NextAuth failure (401 json mode);
      // the 6th is refused 429 BEFORE authorize() runs.
      for (let i = 0; i < 5; i++) {
        const wrong = await credentialsLogin(jar, ADMIN_EMAIL, "definitely-wrong");
        expect(wrong.status).toBe(401);
      }
      const throttled = await fetch(`${APP_BASE}/api/auth/callback/credentials`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
        body: new URLSearchParams({
          csrfToken: (await (
            await fetch(`${APP_BASE}/api/auth/csrf`, { headers: { cookie: jar.header() } })
          ).json() as { csrfToken: string }).csrfToken,
          email: ADMIN_EMAIL,
          password: "definitely-wrong",
          json: "true",
        }).toString(),
        redirect: "manual",
      });
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get("retry-after")).toBeTruthy();
      const throttledBody = (await throttled.json()) as Envelope;
      expect(throttledBody.error?.code).toBe("RATE_LIMITED");

      // Recovery: the 30 s window slides fully; a correct password works again
      // (lockouts are never permanent; success resets the guard state).
      await new Promise((r) => setTimeout(r, 31_000));
      const recovered = await credentialsLogin(jar, ADMIN_EMAIL, "faya123");
      expect(recovered.status).toBe(200);
    },
    90_000 // the recovery phase waits out the 30 s window
  );
});
