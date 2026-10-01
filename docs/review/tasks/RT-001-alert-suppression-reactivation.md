# RT-001 — Alert engine: re-activate / resolve root-suppressed children after the root resolves

## Linked findings

| Finding | Source | Severity | Fix effort | Risk of change |
|---|---|---|---|---|
| F-001 | A3-01 | P1 | S | Low-Medium — touches the shared alert-evaluation engine used by every 3-min evaluation run; behavior must be covered by tests before merge |

## Problem & evidence

`src/lib/alerts/evaluate.ts`:
- Line 463-465: `const suppressedByRoot = existing.status === "SUPPRESSED" && (existing.suppressReason ?? "").startsWith(ROOT_SUPPRESS_PREFIX);` — computed and **never read afterwards** (dead variable, verified by audit A3-01).
- Line 496-514 (pass 1, SUPPRESSED dedup branch): only `suppressedByWindow && !maintenanceFor(device)` re-activates; root-suppressed rows fall into the else branch and are only `lastSeen`-touched.
- Line 679 (pass 2): `if (existing.status !== "ACTIVE" && existing.status !== "ACKNOWLEDGED") continue;` — SUPPRESSED rows are never candidates for auto-resolve.

Consequence (module header comment at the top of evaluate.ts explicitly promises the opposite): a child alert suppressed with `"Suppressed by root alert: <id>"` is never re-activated when the root AVAILABILITY alert resolves, and never auto-resolved when its own condition recovers. Still-breaching condition = permanent silent blind spot; recovered condition = zombie SUPPRESSED rows with stale `parentAlertId` refs.

## Impact

Silent monitoring gap exactly in the scenario suppression was designed for (device blackout windows): after the device comes back and the root clears, dependent metric alerts stay SUPPRESSED forever even while breaching; recovered ones stay open as zombies. Operators trust the alerts view and see nothing.

## Root cause

Pass 1's reactivation branch only handles the maintenance-window expiry case; pass 2's status filter excludes SUPPRESSED rows from the resolve walk. The `suppressedByRoot` flag was added but never wired into either branch.

## Required change

Single file: `src/lib/alerts/evaluate.ts`.

1. **Pass 1 — root-release reactivation** (in the SUPPRESSED dedup branch, lines ~494-515): extend the reactivation condition to also fire for root-suppressed rows. Concretely, inside `if (suppressedByWindow && !maintenanceFor(device)) { ... }`, add an OR-arm:
   - `suppressedByRoot && <no open root for this device>` where "no open root" = no ACTIVE/ACKNOWLEDGED AVAILABILITY alert exists for `device.id`. Cheapest correct check: `const openRoot = await db.alert.findFirst({ where: { deviceId: device.id, status: { in: ["ACTIVE", "ACKNOWLEDGED"] }, dedupKey: { contains: ":AVAILABILITY:" } }, select: { id: true } });` — reactivate only when `openRoot === null`. (Do NOT rely on `openRootByDevice` alone: it only holds roots that breached in the current run.)
   - On reactivation, mirror the window branch: `status: "ACTIVE"`, `suppressReason: null`, `parentAlertId: null`, `lastSeen: now`, `count: { increment: 1 }`, `dedupKey: key`; count into `summary.deduped` (or add a dedicated `summary.reactivated` counter + include it in the summary audit `afterJson` — preferred for observability, mirrors `childrenSuppressed`).
   - Keep maintenance precedence: if `maintenanceFor(device)` is truthy, a root-suppressed row is NOT reactivated (it stays suppressed; the window branch logic already runs first).
2. **Pass 2 — resolve recovered root-suppressed rows** (line ~679): allow SUPPRESSED rows through when they are root-suppressed:
   `if (existing.status !== "ACTIVE" && existing.status !== "ACKNOWLEDGED" && !(existing.status === "SUPPRESSED" && (existing.suppressReason ?? "").startsWith(ROOT_SUPPRESS_PREFIX))) continue;`
   - In the resolve write (lines ~710-713) also clear the parent link when the row was SUPPRESSED: `data: { status: "RESOLVED", suppressReason: null, ...(existing.status === "SUPPRESSED" ? { parentAlertId: null } : {}) }`.
   - Maintenance-suppressed rows must remain skipped (they are owned by the window, not by recovery).
3. Remove the now-dead nature of `suppressedByRoot` (it becomes the branch predicate; no rename needed).
4. Update the header comment block of `evaluateAlerts` ("after the root resolves, children re-activate if their own condition still holds, or resolve with it") to document the implemented semantics.

Constants already available in the file: `ROOT_SUPPRESS_PREFIX` (line 87, exported), `MAINTENANCE_REASON_PREFIX` (line 86). `Alert.dedupKey` format `"<deviceId>:<metric>:<ruleId|adhoc>"` (prisma/schema.prisma:615+).

## Tests to add

File: `tests/audit/alert-suppression-reactivation.test.ts` (unit-level, mirrors the pure-logic test style of `tests/audit/*.test.ts`; mock/seed the two alerts directly if the suite's DB harness is available, else extract the branch predicate into a small exported pure helper `shouldReactivateSuppressedRow(status, suppressReason, maintenanceActive, openRootExists)` and unit-pin it).

1. `reactivates root-suppressed child when root resolved and condition still breaching` — seed SUPPRESSED child with `suppressReason = "Suppressed by root alert: A1"`, no open AVAILABILITY alert on the device, condition breaching → after one evaluation run the row is ACTIVE with `suppressReason = null` and `parentAlertId = null`.
2. `keeps root-suppressed child suppressed while device is in a maintenance window` — same seed + active maintenance window → row stays SUPPRESSED.
3. `keeps root-suppressed child suppressed while a root is still open` — same seed + open ACTIVE AVAILABILITY alert on the device → row stays SUPPRESSED, `lastSeen` advances (dedup path).
4. `resolves recovered root-suppressed child` — SUPPRESSED child, condition recovered for 2 consecutive windows (or AVAILABILITY === 1) → row RESOLVED, `suppressReason = null`, `parentAlertId = null`, `ALERT_RESOLVED` audit row written.
5. `does not auto-resolve maintenance-suppressed rows` — negative/permission-style case: SUPPRESSED with `suppressReason = "Maintenance window: ..."` and recovered condition → row untouched by pass 2.
6. `summary audit reports reactivated count` — the `ALERT_EVALUATION_COMPLETED` afterJson includes the new counter (when the counter variant is implemented).

## Acceptance criteria

- [ ] `suppressedByRoot` is read by both pass 1 (reactivation) and pass 2 (resolve eligibility); no dead variable remains.
- [ ] Root-suppressed child re-activates when the root is gone and its own condition still breaches (and no maintenance window is active).
- [ ] Root-suppressed child auto-resolves when its condition recovers; `parentAlertId` and `suppressReason` are cleared.
- [ ] Maintenance-suppressed rows keep their current behavior (no reactivation, no auto-resolve).
- [ ] ACKNOWLEDGED ownership rule is untouched (pass-2 ACKNOWLEDGED resolve behavior unchanged).
- [ ] Summary audit reflects the new outcome(s).
- [ ] `node_modules/typescript/bin/tsc --noEmit` and `bun run lint` pass.

## Verification

```bash
bun test tests/audit/alert-suppression-reactivation.test.ts   # all new cases green
bun test tests/                                                # no regressions (1340 pass baseline)
node_modules/typescript/bin/tsc --noEmit                       # exit 0, no output
bun run lint                                                   # 0 errors
```

## Rollout & rollback notes

Behavior change is confined to the evaluate-in-Next engine invoked by ALERT_EVALUATION jobs every 3 min; no schema or API contract change. Rollback = revert the single file (stateless — the next evaluation run behaves as before; already re-activated/resolved rows are correct under both versions).


## Status

Fixed (8c5200d)
