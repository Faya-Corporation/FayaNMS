import { lookup } from "node:dns/promises";

/**
 * Webhook egress SSRF guard (P1-010 — external ULTRA audit).
 *
 * The webhook surface lets an admin point FayaNMS at an arbitrary URL; the
 * signed delivery then POSTs there. Without egress controls that POST can be
 * aimed at loopback services, the private network behind the app, or the
 * cloud metadata endpoint (169.254.169.254) — the classic webhook-SSRF
 * class the audit flagged ("URL validation is z.string().url() + scheme
 * only").
 *
 * Defense is enforced at BOTH planes:
 *
 *   ADMISSION (webhook + notification-channel routes) — `classifyWebhookUrl`
 *   is pure and synchronous: strict URL parse, http(s) only, no userinfo
 *   credentials, no blocked hostnames (localhost / *.localhost), and every
 *   hostname that normalizes to a blocked IP literal under the OS resolver's
 *   inet_aton-ish semantics (decimal "2130706433", hex "0x7f000001", octal
 *   "0177.0.0.1", hybrid "127.1") is refused before anything is stored.
 *
 *   DELIVERY (`deliverSignedPost` in integrations/delivery.ts) — the same
 *   classifier runs again on EVERY resolved address (dns.lookup {all:true})
 *   immediately before the fetch, so a public-looking hostname that
 *   resolves into a blocked range is caught at the last possible moment
 *   (the audit's "DNS re-check policy"). Redirects are refused outright
 *   (`redirect: "error"`): a public URL that 302s to the metadata address
 *   can no longer smuggle the request past admission.
 *
 * Blocked ranges (v4): 0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8,
 * 169.254/16 (link-local incl. cloud metadata), 172.16/12, 192.168/16,
 * 192.0.0/24, 192.0.2/24, 198.18/15, 198.51.100/24, 203.0.113/24 (doc),
 * 224/4 (multicast), 240/4 (reserved incl. broadcast).
 * Blocked ranges (v6): :: (unspecified), ::1 (loopback), ::ffff:0:0/96
 * (IPv4-mapped — the embedded v4 address is classified under the v4 rules),
 * 64:ff9b::/96 (NAT64 — embeds an arbitrary v4 destination), 100::/64
 * (discard-only), 2001:db8::/32 (doc), fc00::/7 (ULA), fe80::/10
 * (link-local), ff00::/8 (multicast).
 *
 * Residual risk, documented honestly: the DNS-recheck has a theoretical
 * TOCTOU window (rebinding between lookup and connect). Closing that fully
 * requires pinning the connection to the validated address (custom
 * dispatcher); the two-plane check removes the entire trivial-encoding
 * class and the redirect bypass, which is what the audit required.
 */

/** Greppable prefix carried by every refusal (route 400s + delivery errors). */
export const SSRF_BLOCKED_PREFIX = "SSRF_BLOCKED";

export const DELIVERY_REDIRECT_POLICY = "error";

export type WebhookUrlClassification =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/** Numeric helpers — everything stays in Number-safe integer space. */
function ipv4ToInt(parts: number[]): number {
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr4(ip: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base.split(".").map((p) => Number.parseInt(p, 10)));
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (baseInt & mask);
}

const BLOCKED_V4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/**
 * Classify a CANONICAL IPv4/IPv6 address string. Used on admission for IP
 * literals and on delivery for every resolved address. Unknown formats fail
 * BLOCKED (fail-tight — the resolver only emits canonical forms).
 */
export function isBlockedIpAddress(ip: string): boolean {
  const value = ip.trim().toLowerCase();

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) → classify the embedded v4 address.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) return isBlockedIpAddress(mapped[1]);

  if (value.includes(":")) {
    // --- IPv6 (number-group math — no BigInt needed below ES2020) ---
    const addr = value.split("%")[0]; // strip a zone id (fe80::1%eth0)
    let groups: number[];
    try {
      groups = ipv6Groups(addr);
    } catch {
      return true; // unparsable → fail-tight
    }
    const allZero = groups.every((g) => g === 0);
    if (allZero) return true; // :: unspecified
    if (allZeroExceptLast(groups, 1)) return true; // ::1 loopback
    // IPv4-mapped ::ffff:0:0/96 — embedded v4 classified under v4 rules.
    if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
      const v4 = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
      return isBlockedIpAddress(v4);
    }
    const g0 = groups[0];
    return (
      (g0 === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) || // 64:ff9b::/96 NAT64
      (g0 === 0x0100 && groups.slice(1, 4).every((g) => g === 0)) || // 100::/64 discard-only
      (g0 === 0x2001 && groups[1] === 0x0db8) || // 2001:db8::/32 doc
      (g0 & 0xfe00) === 0xfc00 || // fc00::/7 ULA
      (g0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
      (g0 & 0xff00) === 0xff00 // ff00::/8 multicast
    );
  }

  // --- IPv4 ---
  const parts = value.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // not canonical dotted-quad → fail-tight
  }
  const int = ipv4ToInt(parts);
  return BLOCKED_V4_RANGES.some(([base, bits]) => inCidr4(int, base, bits));
}

/** Every group is zero except the LAST one, which equals `last`. */
function allZeroExceptLast(groups: number[], last: number): boolean {
  return (
    groups.slice(0, 7).every((g) => g === 0) && groups[7] === last
  );
}

/**
 * Expand an IPv6 literal into its eight 16-bit groups. Throws on malformed
 * input (more than one "::", wrong group count, non-hex groups).
 */
function ipv6Groups(addr: string): number[] {
  const head = addr.split("::");
  if (head.length > 2) throw new Error("too many ::");
  const groupsOf = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16));
  const left = groupsOf(head[0]);
  const right = head.length === 2 ? groupsOf(head[1]) : [];
  if (left.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    throw new Error("bad group");
  }
  if (right.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    throw new Error("bad group");
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (head.length === 1 && missing !== 0)) {
    throw new Error("bad group count");
  }
  const groups = [...left, ...Array<number>(Math.max(0, missing)).fill(0), ...right];
  if (groups.length !== 8) throw new Error("not 8 groups");
  return groups;
}

/**
 * Normalize a URL hostname the way an OS resolver would interpret it, and
 * return a canonical IP string when the hostname IS an encoded IP literal
 * (decimal/hex/octal/partial forms). Returns null when the hostname is a
 * genuine DNS name. This closes the "admission sees a name, the resolver
 * sees loopback" gap for the encodings DNS accepts.
 */
export function hostnameAsEncodedIp(hostname: string): string | null {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  if (!/^[\da-fx.]+$/.test(host)) return null; // letters beyond hex/x → a name
  const labels = host.split(".");
  if (labels.length > 4) return null;

  const parseLabel = (label: string): number | null => {
    if (label === "") return null;
    if (/^0x[\da-f]+$/.test(label)) return Number.parseInt(label, 16);
    if (/^0\d+$/.test(label)) return Number.parseInt(label, 8);
    if (/^\d+$/.test(label)) return Number.parseInt(label, 10);
    return null;
  };

  // Single 32-bit value (decimal or hex): 2130706433 / 0x7f000001.
  if (labels.length === 1) {
    const v = parseLabel(labels[0]);
    if (v === null || v > 0xffffffff) return null;
    return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
  }
  // Dotted forms — including partials ("127.1" → 127.0.0.1) and octal
  // labels ("0177.0.0.1" → 127.0.0.1), which getaddrinfo accepts.
  const nums: number[] = [];
  for (const label of labels) {
    const parsed = parseLabel(label);
    if (parsed === null || parsed > 255) return null;
    nums.push(parsed);
  }
  if (nums.length === 4) return nums.join(".");
  if (nums.length < 4) {
    const last = nums.pop() as number;
    const zeros = Array<number>(4 - nums.length - 1).fill(0);
    return [...nums, ...zeros, last].join(".");
  }
  return null;
}

/**
 * ADMISSION-TIME classification of a webhook/notification URL.
 * Pure + synchronous (no DNS). Returns the parsed URL or a refusal reason
 * prefixed with SSRF_BLOCKED_PREFIX.
 */
export function classifyWebhookUrl(rawUrl: string): WebhookUrlClassification {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `${SSRF_BLOCKED_PREFIX}: url is not a valid absolute URL` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `${SSRF_BLOCKED_PREFIX}: only http(s) URLs are accepted` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: `${SSRF_BLOCKED_PREFIX}: userinfo credentials are not allowed in webhook URLs` };
  }
  const hostname = url.hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!hostname) {
    return { ok: false, reason: `${SSRF_BLOCKED_PREFIX}: empty hostname` };
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: `${SSRF_BLOCKED_PREFIX}: loopback hostname "${hostname}" is blocked` };
  }
  // IP literal (canonical or encoded) → classify under the range policy.
  const canonicalIp =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostnameAsEncodedIp(hostname);
  if (canonicalIp !== null && isBlockedIpAddress(canonicalIp)) {
    return {
      ok: false,
      reason: `${SSRF_BLOCKED_PREFIX}: address "${canonicalIp}" is inside a blocked (private/loopback/link-local/metadata) range`,
    };
  }
  return { ok: true, url };
}

export type DeliveryEgressCheck =
  | { ok: true }
  | { ok: false; error: string };

/**
 * DELIVERY-TIME egress check: resolve EVERY address the hostname maps to
 * and refuse unless all of them are outside the blocked ranges. A hostname
 * that resolves to nothing (or only to blocked space) never reaches fetch.
 */
export async function resolveAndValidateWebhookUrl(
  rawUrl: string
): Promise<DeliveryEgressCheck> {
  const classified = classifyWebhookUrl(rawUrl);
  if (!classified.ok) return { ok: false, error: classified.reason };

  const hostname = classified.url.hostname.startsWith("[")
    ? classified.url.hostname.slice(1, -1)
    : classified.url.hostname;

  let records: Array<{ address: string }>;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    // NXDOMAIN and friends — a resolvable-on-admission name that died since
    // is a delivery failure, not an SSRF refusal.
    return {
      ok: false,
      error: `DNS resolution failed for "${hostname}": ${(error as Error)?.message ?? "unknown"}`,
    };
  }
  if (records.length === 0) {
    return { ok: false, error: `DNS resolution returned no addresses for "${hostname}"` };
  }
  const blocked = records.find((r) => isBlockedIpAddress(r.address));
  if (blocked) {
    return {
      ok: false,
      error: `${SSRF_BLOCKED_PREFIX}: "${hostname}" resolves to ${blocked.address}, which is inside a blocked (private/loopback/link-local/metadata) range`,
    };
  }
  return { ok: true };
}
