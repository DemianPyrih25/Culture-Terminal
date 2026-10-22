// pnpm run-skill <skill> <name…>  (tsx --env-file-if-exists=.env tools/dev/run-skill.ts)
//
// Runs one QUANT skill against Qloo through @ct/qloo and the shared Postgres cache, then prints the
// Substitution Map, the metrics, the evidence behind them with its request ids, the findings, every
// Qloo call with its request id and the quota meter. `pnpm run-skill peer_landscape "Liquid Death"`; `--mock` needs no key. See --help.
import { consoleIo } from "./cli/io";
import { runSkillCommand } from "./cli/skill-cli";
import { terminalSafe } from "./cli/table";

runSkillCommand(process.argv.slice(2), { env: process.env, io: consoleIo }).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    consoleIo.err(terminalSafe(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    process.exitCode = 1;
  },
);
