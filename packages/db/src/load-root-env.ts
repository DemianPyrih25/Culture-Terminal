import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository-root .env, found from this file so it works from any working directory. */
export function rootEnvPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env");
}

/**
 * Loads the root .env the way apps/web/next.config.ts does, so `pnpm db:migrate` follows the same
 * DATABASE_URL as the app. Variables already set (shell, CI, Railway) win. Tests never call this.
 * Returns whether a file was loaded.
 */
export function loadRootEnv(file: string = rootEnvPath()): boolean {
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}
