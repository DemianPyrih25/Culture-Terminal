// pnpm exec tsx tools/dev/localities.ts list|pin [--all | <market id>…] [--pick N] [--replace] [--yes]
//
// Pins the Qloo locality of each config/metros.json market in kv (metro_localities, read by
// apps/web/server/localities.ts) through @ct/qloo and the shared Postgres cache. `list` makes no Qloo
// calls; `pin` prints its plan and makes its calls (one /search per market whose answer is not cached)
// only with --yes. Locality ids go to the database kv only, never to the terminal. `--mock` needs no
// key. See --help.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { consoleIo } from "./cli/io";
import { runLocalitiesCommand } from "./cli/localities-cli";
import { terminalSafe } from "./cli/table";

// Started with plain `pnpm exec tsx`, so the root .env (QLOO_API_KEY, QLOO_TAG, DATABASE_URL) loads
// here, as apps/web/next.config.ts loads it; variables already set in the shell win.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

runLocalitiesCommand(process.argv.slice(2), { env: process.env, io: consoleIo }).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    consoleIo.err(terminalSafe(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    process.exitCode = 1;
  },
);
