import "server-only";
import pkg from "../package.json";

/** The deployed commit on Render (RENDER_GIT_COMMIT), else the web package version. */
export function appVersion(env: NodeJS.ProcessEnv = process.env): string {
  const sha = env.RENDER_GIT_COMMIT?.trim();
  return sha ? sha.slice(0, 12) : pkg.version;
}
