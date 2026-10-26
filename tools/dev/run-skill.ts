// pnpm run-skill <skill> …  (tsx --env-file-if-exists=.env tools/dev/run-skill.ts)
//
// Runs one QUANT skill against Qloo through @ct/qloo and the shared Postgres cache, then prints the
// registry, the metrics with their formula ids and badges, the datasets, the evidence behind them with
// its request ids, the findings, every Qloo call with its request id and the quota meter.
// `pnpm run-skill peer_landscape "Brand Alpha"`; any skill from its tool input with
// `pnpm run-skill share_of_taste --names "A,B" --input '{…"set":["R1","R2"]…}'`; `--mock` needs no key. See --help.
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
