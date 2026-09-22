import { afterEach, expect, test } from "bun:test";

const originalToken = process.env.FAYANMS_METRICS_TOKEN;

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.FAYANMS_METRICS_TOKEN;
  } else {
    process.env.FAYANMS_METRICS_TOKEN = originalToken;
  }
});

test("metrics endpoint exposes non-sensitive process metrics", async () => {
  process.env.FAYANMS_METRICS_TOKEN = "";
  const { GET } = await import("@/app/api/metrics/route");
  const response = await GET(new Request("http://localhost/api/metrics"));
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/plain");
  expect(body).toContain("# HELP fayanms_process_uptime_seconds");
  expect(body).toContain("# TYPE fayanms_process_uptime_seconds gauge");
  expect(body).toContain("fayanms_process_resident_memory_bytes");
  expect(body).not.toContain("DATABASE_URL");
  expect(body).not.toContain("NEXTAUTH_SECRET");
});

test("metrics endpoint requires the configured scrape token", async () => {
  process.env.FAYANMS_METRICS_TOKEN = "throwaway-metrics-token";
  const { GET } = await import("@/app/api/metrics/route");

  const denied = await GET(new Request("http://localhost/api/metrics"));
  expect(denied.status).toBe(401);

  const allowed = await GET(
    new Request("http://localhost/api/metrics", {
      headers: { authorization: "Bearer throwaway-metrics-token" },
    })
  );
  expect(allowed.status).toBe(200);
});


test("worker metrics endpoint exposes safe counters and honors the scrape token", async () => {
  process.env.FAYANMS_METRICS_TOKEN = "";
  const { handle } = await import("../../mini-services/worker/index");
  const response = await handle(new Request("http://localhost:3030/api/metrics"));
  const body = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/plain");
  expect(body).toContain("fayanms_worker_jobs_total");
  expect(body).toContain("fayanms_worker_scheduler_up");
  expect(body).not.toContain("DATABASE_URL");
  expect(body).not.toContain("FAYANMS_SERVICE_SECRET");

  process.env.FAYANMS_METRICS_TOKEN = "worker-metrics-token";
  const denied = await handle(new Request("http://localhost:3030/api/metrics"));
  expect(denied.status).toBe(401);
  const allowed = await handle(
    new Request("http://localhost:3030/api/metrics", {
      headers: { authorization: "Bearer worker-metrics-token" },
    })
  );
  expect(allowed.status).toBe(200);
});
