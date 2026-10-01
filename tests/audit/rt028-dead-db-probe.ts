/**
 * RT-028 helper — NOT a test file (no *.test.ts name, nothing runs under
 * `bun test`).
 *
 * The 503 negative case must exercise the REAL route module in a process
 * whose DATABASE_URL points at a dead port (the Prisma client reads the URL
 * at construction, so the parent test process — already connected to the
 * healthy dev DB — cannot prove the down path without this isolation).
 * The parent test (rt028-health-readiness.test.ts) spawns this probe with a
 * dead DATABASE_URL and parses the JSON line printed below.
 */
const { GET } = await import("../../src/app/api/health/route");

const response = await GET();

process.stdout.write(
  "PROBE_RESULT:" + JSON.stringify({
    status: response.status,
    body: await response.text(),
    cacheControl: response.headers.get("cache-control"),
  }),
);

export {};
