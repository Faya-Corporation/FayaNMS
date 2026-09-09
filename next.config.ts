import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* P19 / audit QA-002: a production build must never bypass typecheck.
     Keep this false permanently — CI additionally runs `tsc --noEmit`. */
  typescript: {
    ignoreBuildErrors: false,
  },
  // P19 / audit QA-002: fix unsafe side effects instead of disabling the signal.
  reactStrictMode: true,
};

export default nextConfig;
