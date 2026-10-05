import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../_lib/api";
import { authErrorToFail, requireSessionRead, sessionScopeFor } from "@/lib/auth/session";
import { scopedDeviceWhere, sessionSiteScope } from "@/lib/auth/scope";
import { Prisma } from "@prisma/client";
import { z } from "zod";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * Interfaces inventory — GET /api/v1/interfaces (network.interfaces view)
 *
 * Fleet-wide DeviceInterface inventory joined to its Device (hostname/status),
 * Site (code) and Vendor (name). Read-only listing in the standard envelope:
 *
 *   q            — substring over name / macAddress / description (max 100)
 *   site         — exact Site.code match
 *   hostnameLike — substring over Device.hostname
 *   operStatus   — UP|DOWN|TESTING|UNKNOWN|DORMANT|NOT_PRESENT|LOWER_LAYER_DOWN
 *   adminStatus  — UP|DOWN|TESTING
 *   vlan         — exact VLAN id (1..4094)
 *   sort         — device (default) | name | speed | utilization
 *   order        — asc (default) | desc
 *   page/pageSize— 1..∞ / 10..200 (default 50)
 *
 * `utilization` is a computed column (max(in,out)/speed), so that sort is a
 * bounded client-side sort: up to UTIL_SCAN_CAP matching rows are fetched in
 * the documented base order, utilization is computed per row and the page is
 * sliced in memory (nulls last in both directions, deterministic tie-break by
 * hostname then interface name). Every other sort maps to Prisma orderBy.
 *
 * Summary block (same `where` as the rows, ignoring pagination):
 *   { total, up (operStatus UP), down (operStatus DOWN),
 *     adminDown (adminStatus DOWN), flapping24h (lastFlapAt >= now-24h) }
 * computed with one groupBy (operStatus buckets) + count queries.
 *
 * BigInt bps counters are serialized to JS numbers (JSON.stringify throws on
 * BigInt); at link rates these are far below MAX_SAFE_INTEGER.
 * Read-only GET → no audit event (app convention).
 *
 * F-008 phase 3 (read-plane defense-in-depth): the handler verifies the
 * human session itself (requireSessionRead) — the proxy matcher stays the
 * coarse gate, not the only check, for this read route.
 *
 * F-031 (site scoping — device-domain migration): in sites mode the device
 * relation filter is composed through scopedDeviceWhere — the devices list
 * route's predicate (`site.code IN (…)`) — so interfaces of out-of-scope
 * devices vanish from the rows AND the summary counts (one composition
 * point; deny-all scopes match nothing). Wildcard sessions (no `sites`
 * claim — the single-tenant default) are byte-unchanged.
 * ───────────────────────────────────────────────────────────────────────────── */

const FLAP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Hard cap for the in-memory utilization sort scan (bounded-query rule). */
const UTIL_SCAN_CAP = 5_000;

const OPER_STATUSES = [
  "UP",
  "DOWN",
  "TESTING",
  "UNKNOWN",
  "DORMANT",
  "NOT_PRESENT",
  "LOWER_LAYER_DOWN",
] as const;

const ADMIN_STATUSES = ["UP", "DOWN", "TESTING"] as const;

/** Empty-after-trim string params mean "no filter" rather than a 400. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

const querySchema = z.object({
  q: optionalText(100),
  site: optionalText(32),
  hostnameLike: optionalText(100),
  operStatus: z.enum(OPER_STATUSES).optional(),
  adminStatus: z.enum(ADMIN_STATUSES).optional(),
  vlan: z.coerce.number().int().min(1).max(4094).optional(),
  sort: z.enum(["device", "name", "speed", "utilization"]).default("device"),
  order: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
});

const rowInclude = {
  device: {
    select: {
      hostname: true,
      status: true,
      site: { select: { code: true } },
      vendor: { select: { name: true } },
    },
  },
} satisfies Prisma.DeviceInterfaceInclude;

type RowWithDevice = Prisma.DeviceInterfaceGetPayload<{
  include: typeof rowInclude;
}>;

interface InterfaceRow {
  id: string;
  deviceId: string;
  deviceHostname: string;
  deviceStatus: string;
  siteCode: string | null;
  vendorName: string;
  name: string;
  adminStatus: string;
  operStatus: string;
  speedMbps: number | null;
  macAddress: string | null;
  description: string | null;
  vlan: number | null;
  mtu: number | null;
  inBps: number | null;
  outBps: number | null;
  utilizationPct: number | null;
  lastFlapAt: string | null;
}

/** max(in,out) over link speed, in percent rounded to 1dp; null when unknown. */
function utilizationPct(
  speedMbps: number | null,
  inBps: number | null,
  outBps: number | null
): number | null {
  if (!speedMbps || speedMbps <= 0 || inBps === null || outBps === null) {
    return null;
  }
  const peakBps = Math.max(inBps, outBps);
  return Math.round((peakBps / (speedMbps * 1_000_000)) * 1000) / 10;
}

/** DB row → wire row (BigInt → Number, DateTime → ISO). */
function toRow(row: RowWithDevice): InterfaceRow {
  const inBps = row.countersInBps === null ? null : Number(row.countersInBps);
  const outBps =
    row.countersOutBps === null ? null : Number(row.countersOutBps);
  return {
    id: row.id,
    deviceId: row.deviceId,
    deviceHostname: row.device.hostname,
    deviceStatus: row.device.status,
    siteCode: row.device.site?.code ?? null,
    vendorName: row.device.vendor.name,
    name: row.name,
    adminStatus: row.adminStatus,
    operStatus: row.operStatus,
    speedMbps: row.speedMbps,
    macAddress: row.macAddress,
    description: row.description,
    vlan: row.vlan,
    mtu: row.mtu,
    inBps,
    outBps,
    utilizationPct: utilizationPct(row.speedMbps, inBps, outBps),
    lastFlapAt: row.lastFlapAt ? row.lastFlapAt.toISOString() : null,
  };
}

function orderByFor(
  sort: z.infer<typeof querySchema>["sort"],
  order: "asc" | "desc"
): Prisma.DeviceInterfaceOrderByWithRelationInput[] {
  switch (sort) {
    case "name":
      return [{ name: order }];
    case "speed":
      // Secondary name key keeps null-speed rows deterministically ordered.
      return [{ speedMbps: order }, { name: "asc" }];
    case "utilization":
      // Computed column — base order only; the real sort happens in memory.
      return [{ device: { hostname: "asc" } }, { name: "asc" }];
    case "device":
    default:
      return [{ device: { hostname: order } }, { name: order }];
  }
}

export async function GET(request: Request) {
  try {
    await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }

  const scopeClaims = await sessionScopeFor(request);

  const sp = new URL(request.url).searchParams;
  const parsed = querySchema.safeParse({
    q: sp.get("q") ?? undefined,
    site: sp.get("site") ?? undefined,
    hostnameLike: sp.get("hostnameLike") ?? undefined,
    operStatus: sp.get("operStatus") ?? undefined,
    adminStatus: sp.get("adminStatus") ?? undefined,
    vlan: sp.get("vlan") ?? undefined,
    sort: sp.get("sort") ?? undefined,
    order: sp.get("order") ?? undefined,
    page: sp.get("page") ?? undefined,
    pageSize: sp.get("pageSize") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const {
    q,
    site,
    hostnameLike,
    operStatus,
    adminStatus,
    vlan,
    sort,
    order,
    page,
    pageSize,
  } = parsed.data;

  /* ── where composition (device facets merge under one relation filter) ── */
  const deviceWhere: Prisma.DeviceWhereInput = {};
  if (site) deviceWhere.site = { code: site };
  if (hostnameLike) deviceWhere.hostname = { contains: hostnameLike };

  // F-031: the scope rides the device relation filter (one composition
  // point feeding the rows, the total count AND the summary block — they
  // all share this `where`). Wildcard stays byte-unchanged: no device key
  // unless the request itself carried device facets.
  const scope = sessionSiteScope(scopeClaims);
  const deviceFilter: Prisma.DeviceInterfaceWhereInput =
    scope.mode === "wildcard"
      ? Object.keys(deviceWhere).length > 0
        ? { device: deviceWhere }
        : {}
      : { device: scopedDeviceWhere(scopeClaims, deviceWhere) };

  const where: Prisma.DeviceInterfaceWhereInput = {
    ...(q
      ? {
          OR: [
            { name: { contains: q } },
            { macAddress: { contains: q } },
            { description: { contains: q } },
          ],
        }
      : {}),
    ...deviceFilter,
    ...(operStatus ? { operStatus } : {}),
    ...(adminStatus ? { adminStatus } : {}),
    ...(vlan !== undefined ? { vlan } : {}),
  };

  const flapSince = new Date(Date.now() - FLAP_WINDOW_MS);

  /* ── rows + total ── */
  const [total, scanRows] = await Promise.all([
    db.deviceInterface.count({ where }),
    sort === "utilization"
      ? db.deviceInterface.findMany({
          where,
          include: rowInclude,
          orderBy: orderByFor(sort, order),
          take: UTIL_SCAN_CAP,
        })
      : Promise.resolve(null),
  ]);

  let rows: InterfaceRow[];
  if (scanRows) {
    // Utilization sort: compute → in-memory sort (nulls last in both
    // directions) → deterministic tie-break → slice the requested page.
    const dir = order === "desc" ? -1 : 1;
    const sorted = scanRows.map(toRow).sort((a, b) => {
      const ua = a.utilizationPct;
      const ub = b.utilizationPct;
      if (ua === null && ub === null) return 0;
      if (ua === null) return 1;
      if (ub === null) return -1;
      if (ua !== ub) return (ua - ub) * dir;
      if (a.deviceHostname !== b.deviceHostname) {
        return a.deviceHostname < b.deviceHostname ? -1 : 1;
      }
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return 0;
    });
    rows = sorted.slice((page - 1) * pageSize, page * pageSize);
  } else {
    const pageRows = await db.deviceInterface.findMany({
      where,
      include: rowInclude,
      orderBy: orderByFor(sort, order),
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    rows = pageRows.map(toRow);
  }

  /* ── summary block over the same filtered set (pagination ignored) ── */
  const [adminDown, flapping24h, operGroups] = await Promise.all([
    db.deviceInterface.count({ where: { ...where, adminStatus: "DOWN" } }),
    db.deviceInterface.count({
      where: { ...where, lastFlapAt: { gte: flapSince } },
    }),
    db.deviceInterface.groupBy({
      by: ["operStatus"],
      where,
      _count: { _all: true },
    }),
  ]);
  const operCount = (status: string) =>
    operGroups.find((group) => group.operStatus === status)?._count._all ?? 0;

  return ok(
    {
      summary: {
        total,
        up: operCount("UP"),
        down: operCount("DOWN"),
        adminDown,
        flapping24h,
      },
      rows,
      page: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    },
    { generatedAt: new Date().toISOString() },
    200
  );
}
