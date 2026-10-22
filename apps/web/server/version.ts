import "server-only";
import pkg from "../package.json";

/** The deployed commit on Railway, else the web package version. */
export function appVersion(env: NodeJS.ProcessEnv = process.env): string {
  const sha = env.RAILWAY_GIT_COMMIT_SHA?.trim();
  return sha ? sha.slice(0, 12) : pkg.version;
}
