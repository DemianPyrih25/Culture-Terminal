import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

const repoRoot = path.join(__dirname, "..", "..");

// Local development keeps one .env at the repository root. Variables already set (Railway, CI) win.
const rootEnv = path.join(repoRoot, ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  // Parallel agents run separate dev servers with their own NEXT_DIST_DIR (PLAN §10.1).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  transpilePackages: ["@ct/contracts", "@ct/qloo", "@ct/quant", "@ct/geo", "@ct/agent", "@ct/db"],
  // /method reads the eval's aggregates at request time: ship the file when there is one.
  outputFileTracingIncludes: {
    "/method": ["./content/eval-summary.json"],
    // The share card reads its fonts at request time (lib/og/fonts.ts). Keys are globs over routes: * spans [id].
    "/r/*/card": ["./lib/og/fonts/*.woff"],
  },
  // /trust moved: what we don't do is on /how-it-works, the full rules on /method.
  async redirects() {
    return [{ source: "/trust", destination: "/how-it-works", permanent: true }];
  },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
