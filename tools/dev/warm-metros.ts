// pnpm exec tsx tools/dev/warm-metros.ts (--all | --metro <id>[,<id>…]) [--yes] [--mock]
//
// Warms and truly pins (D25) the city side of each map city on its pinned Qloo locality: the geo_lift
// restaurant baseline heatmap and the block_dna tag fingerprint, music tags and brand list, built by
// the skills' own request builders so runs hit the cache. Prints its plan and calls only with --yes;
// cached requests cost nothing. Locality ids are read from kv and never printed. See --help.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { consoleIo } from "./cli/io";
import { terminalSafe } from "./cli/table";
import { runWarmCommand } from "./cli/warm-metros-cli";

// Started with plain `pnpm exec tsx`, so the root .env (QLOO_API_KEY, QLOO_TAG, DATABASE_URL) loads
// here, as apps/web/next.config.ts loads it; variables already set in the shell win.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

runWarmCommand(process.argv.slice(2), { env: process.env, io: consoleIo }).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    consoleIo.err(terminalSafe(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    process.exitCode = 1;
  },
);
