// pnpm exec tsx tools/dev/audiences.ts list|pin [--yes] [--mock] [--tag T] [--memory]
//
// Pins the audience catalogue (D21) in kv (audience_catalogue, read by every run at start and offered
// to the ANALYST as AUDIENCES) through @ct/qloo and the shared Postgres cache. `list` makes no Qloo
// calls; `pin` prints its plan and makes its calls (one /v2/audiences per allowed family whose answer
// is not cached) only with --yes. Only audience keys and names are stored, never Qloo entity ids.
// `--mock` needs no key. See --help.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAudiencesCommand } from "./audiences-cli";
import { consoleIo } from "./cli/io";
import { terminalSafe } from "./cli/table";

// Started with plain `pnpm exec tsx`, so the root .env (QLOO_API_KEY, QLOO_TAG, DATABASE_URL) loads
// here, as apps/web/next.config.ts loads it; variables already set in the shell win.
const rootEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

runAudiencesCommand(process.argv.slice(2), { env: process.env, io: consoleIo }).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    consoleIo.err(terminalSafe(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    process.exitCode = 1;
  },
);
