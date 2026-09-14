import { describe, expect, test } from "bun:test";

import {
  DELIVERY_REDIRECT_POLICY,
  SSRF_BLOCKED_PREFIX,
  classifyWebhookUrl,
  hostnameAsEncodedIp,
  isBlockedIpAddress,
  resolveAndValidateWebhookUrl,
} from "../../src/lib/integrations/ssrf-guard";
import { deliverSignedPost } from "../../src/lib/integrations/delivery";

/**
 * P1-010 — webhook egress SSRF guard (external ULTRA audit).
 *
 * The audit's finding: webhook URL validation was `z.string().url()` +
 * http(s) scheme only — no loopback/private/link-local/metadata blocking
 * and no redirect/DNS re-check policy, so an admin-defined endpoint could
 * aim the signed delivery at the app's own loopback services, the private
 * network behind it, or the cloud metadata address.
 *
 * These pins hold the guard's contract:
 *   1. the range policy blocks every standard non-routable class (v4 + v6,
 *      incl. IPv4-mapped and NAT64-embedded forms);
 *   2. admission classification catches encoded IP literals the OS resolver
 *      would happily read as loopback (decimal / hex / octal / partial);
 *   3. userinfo credentials and non-http(s) schemes are refused;
 *   4. the delivery-time check refuses a target whose DNS resolution lands
 *      in blocked space, and a refused delivery is a recorded OUTCOME that
 *      never touches the network;
 *   5. redirects are refused outright (the redirect hop was never validated).
 */

/* ───────────────── address range policy ───────────────── */

describe("isBlockedIpAddress — blocked classes", () => {
  const blocked = [
    "127.0.0.1", // IPv4 loopback
    "127.255.255.254", // loopback edge
    "10.1.2.3", // RFC1918 private
    "172.16.0.1", // RFC1918 lower edge
    "172.31.255.255", // RFC1918 upper edge
    "192.168.1.1", // RFC1918 private
    "169.254.169.254", // cloud metadata
    "169.254.0.1", // link-local
    "0.0.0.0", // unspecified / this-network
    "0.1.2.3", // 0/8
    "100.64.0.1", // CGNAT
    "192.0.2.1", // TEST-NET-1 (doc)
    "198.51.100.7", // TEST-NET-2 (doc)
    "203.0.113.9", // TEST-NET-3 (doc)
    "198.18.0.1", // benchmark
    "224.0.0.1", // multicast
    "240.0.0.1", // reserved
    "255.255.255.255", // broadcast
    "::", // IPv6 unspecified
    "::1", // IPv6 loopback
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1", // IPv4-mapped private
    "::ffff:7f00:1", // mapped loopback, zero-compressed form
    "fe80::1", // IPv6 link-local
    "fe80::1%eth0", // link-local with zone id
    "fc00::1", // ULA
    "fd00::1", // ULA (fd00::/8 within fc00::/7)
    "ff02::1", // IPv6 multicast
    "2001:db8::1", // IPv6 doc range
    "64:ff9b::7f00:1", // NAT64 embedding loopback
    "100::1", // discard-only
  ];
  for (const ip of blocked) {
    test(`blocks ${ip}`, () => {
      expect(isBlockedIpAddress(ip)).toBe(true);
    });
  }

  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1", // just outside 172.16/12
    "100.128.0.1", // just outside 100.64/10
    "198.20.0.1", // just outside 198.18/15
    "2606:4c00::1", // public v6
    "2001:4860:4860::8888", // public v6
  ];
  for (const ip of allowed) {
    test(`allows ${ip}`, () => {
      expect(isBlockedIpAddress(ip)).toBe(false);
    });
  }

  test("fails tight on non-canonical junk", () => {
    expect(isBlockedIpAddress("not-an-ip")).toBe(true);
  });
});

/* ───────────── encoded IP literals as hostnames ───────────── */

describe("hostnameAsEncodedIp — inet_aton-style normalization", () => {
  test("decimal 32-bit form", () => {
    expect(hostnameAsEncodedIp("2130706433")).toBe("127.0.0.1");
  });
  test("hex 32-bit form", () => {
    expect(hostnameAsEncodedIp("0x7f000001")).toBe("127.0.0.1");
  });
  test("octal-labeled form", () => {
    expect(hostnameAsEncodedIp("0177.0.0.1")).toBe("127.0.0.1");
  });
  test("partial dotted form", () => {
    expect(hostnameAsEncodedIp("127.1")).toBe("127.0.0.1");
  });
  test("canonical form passes through", () => {
    expect(hostnameAsEncodedIp("10.0.0.5")).toBe("10.0.0.5");
  });
  test("genuine DNS names return null (even hex-flavored ones)", () => {
    expect(hostnameAsEncodedIp("hooks.example.com")).toBe(null);
    expect(hostnameAsEncodedIp("cafe.example.com")).toBe(null);
  });
});

/* ───────────── admission classification ───────────── */

describe("classifyWebhookUrl — admission", () => {
  const blockedUrls: Array<[string, string]> = [
    ["http://127.0.0.1/hook", "v4 loopback"],
    ["http://localhost/hook", "loopback hostname"],
    ["https://app.localhost/hook", "loopback subdomain"],
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["http://192.168.1.5/hook", "RFC1918"],
    ["http://10.0.0.10/hook", "RFC1918"],
    ["http://[::1]/hook", "v6 loopback"],
    ["http://[fe80::1]/hook", "v6 link-local"],
    ["http://2130706433/hook", "decimal-encoded loopback"],
    ["http://0x7f000001/hook", "hex-encoded loopback"],
    ["http://0177.0.0.1/hook", "octal-encoded loopback"],
    ["http://127.1/hook", "partial-encoded loopback"],
    ["ftp://hooks.example.com/hook", "non-http scheme"],
  ];
  for (const [url, why] of blockedUrls) {
    test(`refuses ${why} (${url})`, () => {
      const result = classifyWebhookUrl(url);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.startsWith(SSRF_BLOCKED_PREFIX)).toBe(true);
    });
  }

  test("refuses userinfo credentials", () => {
    const result = classifyWebhookUrl("https://user:pass@hooks.example.com/hook");
    expect(result.ok).toBe(false);
  });

  test("accepts public http(s) targets", () => {
    expect(classifyWebhookUrl("https://hooks.example.com/x").ok).toBe(true);
    expect(classifyWebhookUrl("http://8.8.8.8/hook").ok).toBe(true);
  });

  test("refuses unparseable input with the greppable prefix", () => {
    const result = classifyWebhookUrl("not a url");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.startsWith(SSRF_BLOCKED_PREFIX)).toBe(true);
  });
});

/* ───────────── delivery-time egress gate ───────────── */

describe("resolveAndValidateWebhookUrl — delivery", () => {
  test("loopback targets are refused before DNS (classification short-circuit)", async () => {
    const result = await resolveAndValidateWebhookUrl("http://127.0.0.1/hook");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.startsWith(SSRF_BLOCKED_PREFIX)).toBe(true);
  });

  test("a name that cannot resolve is a plain failure, not an SSRF refusal", async () => {
    // .invalid is guaranteed NXDOMAIN (RFC 2606) — hermetic, no network.
    const result = await resolveAndValidateWebhookUrl(
      "http://nonexistent-fayanms-ssrf.invalid/hook"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.startsWith("DNS resolution failed")).toBe(true);
  });

  test("localhost (always resolvable) is caught by the hostname policy", async () => {
    const result = await resolveAndValidateWebhookUrl("http://localhost:8080/hook");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.startsWith(SSRF_BLOCKED_PREFIX)).toBe(true);
  });
});

describe("deliverSignedPost — egress wiring", () => {
  test("an SSRF-blocked target is a recorded FAILED outcome, never a throw", async () => {
    // Port 9 (discard) would hang if the fetch were attempted; the guard
    // must refuse BEFORE the network so this returns immediately.
    const outcome = await deliverSignedPost(
      "http://127.0.0.1:9/hook",
      { probe: true },
      "k".repeat(32)
    );
    expect(outcome.delivered).toBe(false);
    expect(outcome.status).toBe("FAILED");
    expect(outcome.statusCode).toBe(null);
    expect(outcome.error?.startsWith(SSRF_BLOCKED_PREFIX)).toBe(true);
  });

  test("redirects are refused by policy (the hop is never validated)", () => {
    expect(DELIVERY_REDIRECT_POLICY).toBe("error");
  });
});
