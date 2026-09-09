# Task 18-a — Interfaces inventory (network.interfaces) — implementation notes

## Files (ownership respected)
- `src/app/api/v1/interfaces/route.ts` (NEW) — GET only, `dynamic = "force-dynamic"`, standard `ok()/fail()` envelope via `../_lib/api`, `requestContext` passed (correct GET rate budget), `firstIssueMessage` on 400s.
- `src/components/views/interfaces-view.tsx` (NEW) — the view (not routed yet; orchestrator wires it).
- `src/hooks/api/use-interfaces.ts` (NEW) — `useInterfaces` + `fetchInterfaces` + exported payload types.
- `agent-ctx/18-a-i18n.json` (NEW) — flat `netif.*` keys, EN = AR (47 = 47, parity script-verified).

## Engineering decisions
1. **Summary is computed over the FILTERED set** (same `where` as the rows, pagination
   ignored) — KPI cards react to the filter bar, which is the more useful reading for an
   inventory dashboard; `summary.total` equals `page.total` when no filters are set.
   Composed of one `groupBy(operStatus)` (up/down buckets) + `count` for total/adminDown/
   flapping24h (lastFlapAt >= now-24h).
2. **`sort=utilization` is a bounded client-side sort** (computed column, as specified):
   up to `UTIL_SCAN_CAP = 5000` matching rows fetched in a documented base order
   (device.hostname asc, name asc), utilization computed per row, in-memory sort with
   **nulls last in BOTH directions** and deterministic tie-break (hostname, then name),
   then the page is sliced. `total` still comes from a real `count`. Verified
   page1/page2 continuity for desc (84.5 → … → 60.5 | 59.5 → … → 46.1) and
   nulls-last for asc (41 nulls of 156 at the tail).
3. **BigInt → Number** for `countersInBps/countersOutBps` (spec: numbers, not the
   string convention used by the older per-device routes; live bps rates are far below
   `MAX_SAFE_INTEGER`). `JSON.stringify` would throw on BigInt — mapped in `toRow()`.
4. **pageSize contract deviation from the verification example (documented):** the task's
   validation spec says `pageSize int 10..200 default 50`, so `?pageSize=5` correctly
   answers **400 INVALID_QUERY** (the "try pageSize=5" line in the verification checklist
   predates that bound). `pageSize=10/50/200` return the success envelope.
5. **Empty-after-trim text params (`q`, `site`, `hostnameLike`) are treated as absent**
   rather than 400 — mirrors `buildQueryString` skipping empty values on the client.
   `vlan` uses `z.coerce.number().int().min(1).max(4094)`; enum params use `z.enum`.
6. **Site filter is exact `Site.code`**; site OPTIONS come from the existing
   `useMeta()` hook (`meta.data.sites` → `{id, name, code}`), the same read-only
   approach devices-view/perf-interfaces-view use (no new sites fetch).
7. **Row navigation mirrors devices-view**: entry point calls
   `setActiveView("network.device-detail", { deviceId })`. The row itself has an
   onClick alias of the same call; the nested focusable `<button>` (device hostname)
   carries the accessible name (`table.openRowAria` with {device}/{name}), tooltip and
   the keyboard path (stopPropagation avoids the double call).
8. **Statuses reuse the platform machinery** — `StatusBadge` +
   `getStatusConfig(INTERFACE_ADMIN_STATUS / INTERFACE_OPER_STATUS / DEVICE_STATUS, …)`;
   labels resolve through `useStatusLabel()` into the already-localized
   `status.interfaceAdmin.*` / `status.interfaceOper.*` keys (no duplication in the
   handoff). KPI cards use `KpiCard` with `status: {token}` (success/danger/neutral/
   warning) + dashboard-style loading/`—` states. No indigo/blue anywhere.
9. **Table = perf-interfaces-view pattern** (max-h-[600px] overflow-auto, sticky thead
   bg-card, density-agnostic px-4/py-2 cells) with a `min-w-[1080px]` table INSIDE the
   scroll container → 375px-safe (page scrollWidth stays 375; only the table scrolls).
   Filter bar uses devices-view classes (`flex flex-wrap`, `h-9 w-full sm:w-40`,
   debounced search ~300 ms). Custom scrollbars are global (globals.css).
10. **"Last flap"** renders date-fns `formatDistanceToNow(…, { addSuffix: true })` or
    "—" — the established ha-view relative-time pattern (date-fns generates the string;
    not an i18n key — noted in the handoff `_comment`).
11. **Reused i18n keys:** `common.clear` (clear-filters button) + the status.* keys
    above. Everything else the view renders is in `agent-ctx/18-a-i18n.json`.
    Pre-existing shared-component strings NOT owned by this shard: `ErrorState`'s
    built-in "Retry" button label (same on every existing view; `common.retry` exists
    for whenever the shared component gets localized).

## Verification evidence
- `bunx tsc --noEmit` → **0 errors in all 4 shard files**; remaining src/ errors are in
  `src/components/views/topology-view.tsx` — created mid-session by the CONCURRENT
  18-x shard (file did not exist at shard start; not in my ownership), plus the
  documented pre-existing noise in `examples/ skills/ tool-results/`.
- `bun run lint` → **exit 0**.
- curl (session cookie via NextAuth credentials demo login, since /api/v1/* sits behind
  the Task 7-a middleware gate):
  - `GET /api/v1/interfaces?pageSize=10` → `success: true`, summary
    `{total:156, up:122, down:34, adminDown:30, flapping24h:11}`, page
    `{1,10,156,16}`, 10 rows.
  - `?operStatus=UP` → total 122, every row operStatus UP; `?site=DC-ADN&adminStatus=UP`
    → 38 rows, all DC-ADN/UP; `?q=wan&hostnameLike=core`, `?vlan=20` verified too.
  - `?sort=utilization&order=desc` page1/page2 continuity + asc nulls-last verified.
  - `?operStatus=BOGUS` → 400 `INVALID_QUERY` ("Invalid option…"), `?vlan=9999` → 400
    ("Too big…"), `?pageSize=5` → 400 ("Too small…") per the 10..200 contract.
  - unauthenticated → 401 `UNAUTHENTICATED` envelope (platform gate, expected).
- dev.log tail: all `/api/v1/interfaces` lines are clean 200/400 responses; the only
  error ever logged against this route (a `Module not found: ../../_lib/api` right after
  first write) was fixed in-place to `../_lib/api` and re-verified. Dev server went down
  briefly mid-session (platform OOM/restart pattern known from worklog) and auto-
  recovered; all curls re-run cleanly after recovery. No db/schema/dependency changes;
  nothing committed; no db:push.
