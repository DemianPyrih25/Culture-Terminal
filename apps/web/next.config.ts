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
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
