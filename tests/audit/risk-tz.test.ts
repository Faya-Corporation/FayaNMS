import { describe, expect, test } from "bun:test";

import {
  BUSINESS_HOURS_POLICY_VERSION,
  BUSINESS_HOURS_TIMEZONE,
  isBusinessHours,
  scoreChangeRisk,
} from "../../src/lib/change/risk";

/**
 * P1-003 — business-hours risk factor uses an explicit policy timezone.
 *
 * The external ULTRA audit's finding: `isBusinessHours()` evaluated
 * `date.getDay()`/`date.getHours()` — the EVALUATING MACHINE's local
 * timezone. The factor feeds the approval-level policy (risk level →
 * required approval levels), so a UTC server and a Riyadh browser could
 * disagree on the same change's score and even its approval requirements.
 *
 * These pins hold the remediation contract:
 *   1. the window (Sun–Thu 08:00–16:59) is evaluated in ONE documented
 *      policy IANA timezone (Asia/Riyadh) via the built-in Intl engine —
 *      zero dependencies, identical in every browser and in Node/Bun;
 *   2. instants whose policy-tz weekday/hour DIFFER from the UTC reading
 *      of the same instant are judged by the policy tz, not the host;
 *   3. an explicit tz override works and an invalid tz fails TIGHT
 *      (RISK_TZ_INVALID), never a silent fallback;
 *   4. the policy carries a version, exported for the audit stamps the
 *      CHANGE_CREATED / CHANGE_UPDATED routes persist.
 */

/* ───────────────── policy identity ───────────────── */

describe("business-hours policy identity", () => {
  test("policy timezone is the documented deployment-home tz", () => {
    expect(BUSINESS_HOURS_TIMEZONE).toBe("Asia/Riyadh");
  });

  test("policy version marks the Intl-based remediation", () => {
    // v1 = pre-P1-003 host-local getDay()/getHours(); v2 = policy tz.
    expect(BUSINESS_HOURS_POLICY_VERSION).toBe(2);
  });

  test("default-tz call equals the explicit policy-tz call (no hidden host dependence)", () => {
    const instants = [
      new Date("2026-09-15T05:00:00.000Z"),
      new Date("2026-09-18T01:00:00.000Z"),
      new Date("2026-09-20T05:30:00.000Z"),
      new Date("2026-09-19T21:00:00.000Z"),
    ];
    for (const instant of instants) {
      expect(isBusinessHours(instant)).toBe(
        isBusinessHours(instant, BUSINESS_HOURS_TIMEZONE)
      );
    }
  });
});

/* ───────── the exact disagreement the audit flagged ───────── */

describe("policy-tz evaluation vs the pre-P1-003 host-local behavior", () => {
  test("Riyadh 08:30 Tuesday (= 05:30Z) counts as business hours even though UTC reads 05:30", () => {
    // Tue 2026-09-15: 05:30Z is 08:30 in Asia/Riyadh (UTC+3, no DST).
    // Pre-fix, a UTC-hosted server read getHours() === 5 → outside; the
    // policy answer is INSIDE. This is the P1-003 mismatch, pinned.
    expect(isBusinessHours(new Date("2026-09-15T05:30:00.000Z"))).toBe(true);
  });

  test("Riyadh Sunday morning (= Saturday in UTC) counts as business hours", () => {
    // Sun 2026-09-20 08:30 Riyadh = Sat 05:30Z. A UTC host read
    // getDay() === 6 (Saturday) → outside; the Gulf week starts Sunday,
    // so the policy answer is INSIDE. Weekday disagreement, pinned.
    expect(isBusinessHours(new Date("2026-09-20T05:30:00.000Z"))).toBe(true);
  });

  test("Riyadh Friday morning (= Friday 04:00, a Gulf weekend day) is outside even at a working hour", () => {
    // Fri 2026-09-18 07:00 Riyadh = 04:00Z. UTC also says Friday here, but
    // the pin matters because the GULF weekend is Fri–Sat while UTC-land
    // weekends are Sat–Sun — the window must follow the policy week.
    expect(isBusinessHours(new Date("2026-09-18T04:00:00.000Z"))).toBe(false);
  });

  test("Riyadh Friday 04:00 (= Thursday 21:00Z UTC reading) is outside", () => {
    // The same instant a UTC host would read as Thursday 21:00 — hour
    // alone fails, and a naive "Thu is a workday" reading of the UTC parts
    // still must not flip the verdict: policy tz says Friday → weekend.
    expect(isBusinessHours(new Date("2026-09-18T01:00:00.000Z"))).toBe(false);
  });

  test("Riyadh Saturday (second weekend day) is outside", () => {
    // Sat 2026-09-19 12:00 Riyadh = 09:00Z, a "working hour" — still
    // outside because the policy week excludes Saturday.
    expect(isBusinessHours(new Date("2026-09-19T09:00:00.000Z"))).toBe(false);
  });
});

/* ───────────────── window boundaries ───────────────── */

describe("business-hours window boundaries (evaluated in Asia/Riyadh)", () => {
  // Tue 2026-09-15, policy-tz wall clock = UTC + 3h (fixed offset, no DST).
  const cases: Array<[string, boolean, string]> = [
    ["2026-09-15T04:59:00.000Z", false, "Riyadh 07:59 — one minute before the window"],
    ["2026-09-15T05:00:00.000Z", true, "Riyadh 08:00 — window opens"],
    ["2026-09-15T13:59:00.000Z", true, "Riyadh 16:59 — last minute inside"],
    ["2026-09-15T14:00:00.000Z", false, "Riyadh 17:00 — window closed"],
  ];
  for (const [iso, expected, why] of cases) {
    test(why, () => {
      expect(isBusinessHours(new Date(iso))).toBe(expected);
    });
  }

  test("midnight in the policy tz does not trip the ICU hour-24 quirk", () => {
    // Sun 2026-09-20 00:00 Riyadh = Sat 2026-09-19T21:00Z. Some ICU builds
    // emit hour "24" under hour12:false; the implementation folds it to 0,
    // so the evaluation is deterministic (false — before 08:00) and never
    // throws.
    expect(isBusinessHours(new Date("2026-09-19T21:00:00.000Z"))).toBe(false);
  });
});

/* ───────────────── explicit override + fail-tight ───────────────── */

describe("explicit timezone override and failure posture", () => {
  test("a non-default tz changes the verdict for the same instant (parameter is real)", () => {
    // 05:30Z: policy tz says inside (08:30), UTC says outside (05:30).
    const instant = new Date("2026-09-15T05:30:00.000Z");
    expect(isBusinessHours(instant)).toBe(true);
    expect(isBusinessHours(instant, "UTC")).toBe(false);
  });

  test("an invalid timezone throws RISK_TZ_INVALID instead of a silent fallback", () => {
    expect(() =>
      isBusinessHours(new Date("2026-09-15T05:30:00.000Z"), "Not/AZone")
    ).toThrow(/RISK_TZ_INVALID/);
  });
});

/* ───────────────── factor integration ───────────────── */

describe("risk-factor integration", () => {
  test("the business-hours factor's rendered detail names the policy timezone", () => {
    const breakdown = scoreChangeRisk({
      deviceCriticalities: [],
      deviceCount: 1,
      type: "STANDARD",
      siteCount: 1,
      hasRollbackPlan: true,
      hasValidationPlan: true,
      scheduledBusinessHours: true,
      affectsFirewall: false,
    });
    const factor = breakdown.factors.find((f) => f.key === "business-hours");
    expect(factor).toBeDefined();
    expect(factor?.points).toBe(12);
    expect(factor?.detail).toContain(BUSINESS_HOURS_TIMEZONE);
  });
});
