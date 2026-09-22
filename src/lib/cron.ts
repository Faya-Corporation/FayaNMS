/**
 * FayaNMS — shared cron helpers for backup policies.
 *
 * The scheduler (worker mini-service → POST /api/v1/worker/tick) parses
 * plain 5-field numeric cron expressions: star, exact values, a-b ranges,
 * a,b lists and /step values (Vixie dom/dow union, 7 = Sunday). Names
 * ("SUN", "FEB") and @shortcuts are deliberately NOT supported — this
 * validator therefore rejects anything the scheduler could never fire,
 * so a policy can never be created that looks valid but never runs.
 *
 * Pure functions, no dependencies — safe on server and client.
 */

const FIELD_BOUNDS: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 = Sunday)
];

/**
 * True when `expr` is a 5-field cron expression the tick scheduler can
 * evaluate (numbers, `*`, ranges `a-b`, lists `a,b`, steps `star/n`).
 */
export function isValidCronExpr(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  return fields.every((field, index) => {
    const [min, max] = FIELD_BOUNDS[index];
    if (!field) return false;
    return field.split(",").every((rawPart) => {
      const part = rawPart.trim();
      if (!part) return false;
      let range = part;
      if (part.includes("/")) {
        const [r, s] = part.split("/");
        range = r;
        const step = Number.parseInt(s, 10);
        if (!Number.isFinite(step) || step < 1) return false;
      }
      if (range === "*" || range === "") return true;
      if (range.includes("-")) {
        const [a, b] = range.split("-").map((n) => Number.parseInt(n, 10));
        return (
          Number.isFinite(a) &&
          Number.isFinite(b) &&
          a >= min &&
          b <= max &&
          a <= b
        );
      }
      const n = Number.parseInt(range, 10);
      return Number.isFinite(n) && n >= min && n <= max;
    });
  });
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

type TranslateFn = (key: string, values?: Record<string, string | number>) => string;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Humanized hint for the common policy patterns ("Daily 02:00",
 * "Every 6 hours at :00", "Weekly on Sunday 03:00", "Every 15 minutes",
 * "Hourly at :00"). Returns null when the expression does not match a
 * well-known shape — callers then show only the raw cron string.
 */
export function cronHint(expr: string, t?: TranslateFn): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [m, h, dom, mon, dow] = fields;

  const isStar = (v: string) => v === "*";
  const isInt = (v: string) => /^\d+$/.test(v);
  const isStep = (v: string) => /^\*\/(\d+)$/.test(v);
  const stepOf = (v: string) => Number.parseInt(v.slice(2), 10);
  const translate = (key: string, values: Record<string, string | number>, fallback: string) =>
    t ? t(key, values) : fallback;

  // */n * * * * — every n minutes
  if (isStep(m) && isStar(h) && isStar(dom) && isStar(mon) && isStar(dow)) {
    const n = stepOf(m);
    return n > 0 && n < 60
      ? translate("cron.everyMinutes", { count: n, suffix: n === 1 ? "" : "s" }, `Every ${n} minute${n === 1 ? "" : "s"}`)
      : null;
  }
  // m * * * * — hourly
  if (isInt(m) && isStar(h) && isStar(dom) && isStar(mon) && isStar(dow)) {
    return translate("cron.hourly", { minute: pad2(Number(m)) }, `Hourly at :${pad2(Number(m))}`);
  }
  // m */n * * * — every n hours
  if (
    isInt(m) &&
    isStep(h) &&
    isStar(dom) &&
    isStar(mon) &&
    isStar(dow)
  ) {
    const n = stepOf(h);
    return n > 0 && n <= 24
      ? translate("cron.everyHours", { count: n, suffix: n === 1 ? "" : "s", minute: pad2(Number(m)) }, `Every ${n} hour${n === 1 ? "" : "s"} at :${pad2(Number(m))}`)
      : null;
  }
  // m h * * * — daily
  if (isInt(m) && isInt(h) && isStar(dom) && isStar(mon) && isStar(dow)) {
    return translate("cron.daily", { hour: pad2(Number(h)), minute: pad2(Number(m)) }, `Daily at ${pad2(Number(h))}:${pad2(Number(m))}`);
  }
  // m h * * dow — weekly
  if (isInt(m) && isInt(h) && isStar(dom) && isStar(mon) && /^\d$/.test(dow)) {
    const day = DAY_NAMES[Number(dow) % 7];
    const dayKey = day.toLowerCase();
    const localizedDay = t ? t(`cron.days.${dayKey}`) : day;
    return translate("cron.weekly", { day: localizedDay, hour: pad2(Number(h)), minute: pad2(Number(m)) }, `Weekly on ${day} at ${pad2(Number(h))}:${pad2(Number(m))}`);
  }
  return null;
}
