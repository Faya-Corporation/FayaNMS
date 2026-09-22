const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export const dynamic = "force-dynamic";

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function unauthorized(): Response {
  return new Response("Unauthorized\n", {
    status: 401,
    headers: {
      "content-type": CONTENT_TYPE,
      "cache-control": "no-store",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const configuredToken = process.env.FAYANMS_METRICS_TOKEN?.trim() ?? "";
  if (configuredToken.length > 0) {
    const supplied = request.headers.get("authorization") ?? "";
    if (supplied !== `Bearer ${configuredToken}`) {
      return unauthorized();
    }
  }

  const memory = process.memoryUsage();
  const version = escapeLabel(process.env.FAYANMS_RELEASE_SHA?.trim() || "unknown");
  const lines = [
    "# HELP fayanms_process_uptime_seconds Process uptime in seconds.",
    "# TYPE fayanms_process_uptime_seconds gauge",
    `fayanms_process_uptime_seconds ${process.uptime().toFixed(3)}`,
    "# HELP fayanms_process_resident_memory_bytes Resident process memory in bytes.",
    "# TYPE fayanms_process_resident_memory_bytes gauge",
    `fayanms_process_resident_memory_bytes ${memory.rss}`,
    "# HELP fayanms_process_heap_used_bytes Used V8 heap in bytes.",
    "# TYPE fayanms_process_heap_used_bytes gauge",
    `fayanms_process_heap_used_bytes ${memory.heapUsed}`,
    "# HELP fayanms_build_info Build identity for this process.",
    "# TYPE fayanms_build_info gauge",
    `fayanms_build_info{version="${version}"} 1`,
  ];

  return new Response(`${lines.join("\n")}\n`, {
    status: 200,
    headers: {
      "content-type": CONTENT_TYPE,
      "cache-control": "no-store",
    },
  });
}
