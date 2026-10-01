import type { NextConfig } from "next";

// RT-007 / F-009 — security headers are INTRINSIC to the app layer, not a
// property of the chosen ingress. The set below mirrors the proven TLS
// Caddy profile (deploy/oci/Caddyfile header block) byte-for-byte;
// tests/audit/rt007-security-headers.test.ts pins the two owners in
// lockstep — extend the CSP in BOTH files together, never one.
//   - HSTS is deliberately NOT set here: on plain-HTTP origins it is
//     ignored/misleading, and the TLS Caddy profile keeps single ownership
//     of Strict-Transport-Security.
//   - X-Frame-Options is likewise omitted: CSP `frame-ancestors 'none'`
//     below is the single owner of that directive (DENY would be redundant).
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob: https:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' https: wss:; upgrade-insecure-requests";

const nextConfig: NextConfig = {
  output: "standalone",
  /* P19 / audit QA-002: a production build must never bypass typecheck.
     Keep this false permanently — CI additionally runs `tsc --noEmit`. */
  typescript: {
    ignoreBuildErrors: false,
  },
  // P19 / audit QA-002: fix unsafe side effects instead of disabling the signal.
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Content-Security-Policy",
            value: CONTENT_SECURITY_POLICY,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
