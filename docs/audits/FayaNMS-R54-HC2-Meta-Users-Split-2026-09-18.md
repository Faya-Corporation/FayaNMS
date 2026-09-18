# FayaNMS — R54 / HC-2 Evidence: Authenticated Bootstrap Split for `/api/v1/meta` (2026-09-18)

**Increment:** HC-2 of the Production-Readiness Implementation Roadmap — the F-N3 finding closed: the session-exempt bootstrap surface no longer exposes the active user directory.

---

## 1. Design

- **`GET /api/v1/meta`** (session-exempt, unchanged exemption — exact-match `pathname === "/api/v1/meta"` in `src/proxy.ts`): now carries ONLY the pre-auth-needed reference data for the sign-in transition — `vendors`, `sites`, `credentialProfiles` (R51-A2 shape kept: id/name/type, no usernames). The `users` query and payload segment are REMOVED; the route no longer touches the user table.
- **`GET /api/v1/meta/users`** (NEW, authenticated): the active account directory (id/name/roleLabel + email local-part username key — the exact shape the pickers already consumed). Defense in depth:
  1. the proxy matcher `/api/v1/:path*` gates it and the bootstrap exemption does NOT cover it (exact-match discipline);
  2. the handler resolves the actor BEFORE the DB read (R52-F-N1 ordering discipline — 401 UNAUTHENTICATED, never a pre-auth read; exactly-once `resolveActingUser`);
  3. API-client opaque tokens are refused on the read plane by the proxy (P1-012, pre-existing).
- **Client split:** `MetaPayload` sheds `users`; NEW `MetaUsersPayload`; NEW `useMetaUsers()` hook (queryKey `["meta","users"]`, same 5-min staleTime); BOTH consumers migrated — `alert-action-dialogs.tsx` (assign picker) and `incident-detail-view.tsx` (incident owner picker, discovered during the consumer sweep). No other `.users` consumers existed.

## 2. Regression pins (10 NEW in `tests/audit/r54-meta-users-split.test.ts`)

1. **Wire-level (real handler, CI DB):** `GET /api/v1/meta` → 200, body.data has NO `users` key; vendors/sites/credentialProfiles arrays present; R51-A2 still holds (no profile `username`).
2. Source: the meta route no longer queries the user table (`db.user.findMany` / `roleLabel` absent).
3. The users route exists with the actor gate BEFORE `db.user.findMany` + exactly-once resolution.
4. Wire-level: `GET /api/v1/meta/users` without a session → 401 UNAUTHENTICATED (handler).
5. Proxy exemption stays EXACT: `pathname === "/api/v1/meta"` present; the string `"/api/v1/meta/users"` absent from `src/proxy.ts`.
6. Proxy end-to-end: unauth `GET /api/v1/meta` → forwarded (`x-middleware-next: 1`); unauth `GET /api/v1/meta/users` → 401 UNAUTHENTICATED envelope.
7. Client: the `MetaPayload` interface body declares no `users:` property; `MetaUsersPayload` exists with `users: UserOption[]`.
8. Client: `useMetaUsers` fetches `/api/v1/meta/users` under `queryKeys.metaUsers`.
9. Client: BOTH consumers import `useMetaUsers` and no longer call `useMeta(`.
10. Query key registered: `metaUsers: ["meta", "users"] as const`.

## 3. Gates (CI env shape, `.env` stash/restore + exported CI secret set)

- lint **0** · tsc `--noEmit` full **0** · suite **915 pass / 18 skip / 0 fail** (905 → 915, +10 HC-2 pins), **5,009 expects, 53 files**, 3.87 s.

## 4. LIVE verification (deployed stack)

| Probe | Expected | Observed |
|---|---|---|
| Unauth `GET /api/v1/meta` | 200, zero user records | **200**, keys exactly `['credentialProfiles','sites','vendors']`, `has users: False` ✅ |
| Unauth `GET /api/v1/meta/users` | 401 | **401** ✅ |
| Authenticated `GET /api/v1/meta/users` (browser admin session) | 200 + users | **200**, 5 active users, first = `{id: usr-admin, name: Amal Al-Sabri, roleLabel: Administrator, username: admin}` ✅ |

**E2E picker journey (browser):** sign-in → OPERATIONS → Alerts → alert row actions (HQ-IDF-SW-01) → **Assign…** → the Assignee combobox renders ALL five active users from the NEW endpoint (`Amal Al-Sabri · Administrator`, `Yousef Ghalib · NOC Operator`, `Mariam Al-Hakimi · Network Engineer`, `Tariq Bashiri · Auditor`, `Salma Al-Attar · Service Manager`) → selected `Salma Al-Attar · Service Manager` → **Assign** submitted → dialog closed, the alert row shows the assignee. 0 console errors; mobile 390×844 no h-scroll. Screenshots: `agent-ctx/verify-r54-hc2-assign-picker.png`, `agent-ctx/verify-r54-hc2-mobile-390.png`.

## 5. Documentation updated

- README §Security posture — bootstrap-surface split noted (zero user records pre-auth, machine-pinned; user directory behind the session plane).
- `NEXT-TASKS` header + ACTIVE queue + the TASK-HC-2 LANDED block; roadmap status ledger (HC-2 → LANDED, HC-3 → NEXT).

## 6. Honest scope

- The pre-auth surface previously exposed the user directory **by design for the demo lab** (R52-F-N2 documented the consumer); HC-2 closes it for production posture while keeping the demo picker UX identical (the shell only renders behind the session, so the hydrated fetch always has a live cookie).
- `username` remains the email local-part on the AUTHENTICATED surface (R51-accepted identity shape — no emails beyond the local-part anywhere).
- Demo-lab trade-off unchanged: `FAYANMS_DEMO_MODE` still governs seeded credentials; the split is config-independent.
