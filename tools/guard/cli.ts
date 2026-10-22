import path from "node:path";
import { scanBundleDir } from "./client-bundle";
import { dedupe, formatFinding, githubAnnotation } from "./finding";
import { scanHistory, scanWorkingTree, type ScanResult } from "./no-qloo-data";

export const USAGE = `Usage: pnpm guard [--history] [--bundle [--dir <path>]]

  (no flag)   scan the working tree: tracked files (on disk and as staged) plus untracked files
              that are not ignored
  --history   scan every blob reachable from any ref, and every commit and tag message
  --bundle    scan the built client bundle (apps/web/<NEXT_DIST_DIR or .next>/static)
  --dir       override the bundle directory, relative to the repository root

Exit codes: 0 clean, 1 findings, 2 usage or setup error.`;

export interface CliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  env: Record<string, string | undefined>;
}

const defaultIo: CliIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  env: process.env,
};

type Mode = "tree" | "history" | "bundle";

function parseArgs(argv: readonly string[]): { modes: Mode[]; dir?: string; help: boolean } {
  const modes = new Set<Mode>();
  let dir: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--history") modes.add("history");
    else if (arg === "--bundle") modes.add("bundle");
    else if (arg === "--dir") {
      dir = argv[++i];
      if (!dir) throw new Error("--dir needs a path");
    } else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--") continue;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (dir !== undefined && !modes.has("bundle")) throw new Error("--dir only applies to --bundle");
  if (modes.size === 0) modes.add("tree");
  return { modes: [...modes], dir, help };
}

export function main(argv: readonly string[], root: string, io: CliIo = defaultIo): number {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.error(`guard: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    io.log(USAGE);
    return 0;
  }

  const annotate = io.env.GITHUB_ACTIONS === "true";
  let total = 0;
  for (const mode of args.modes) {
    let result: ScanResult;
    let label: string;
    try {
      if (mode === "tree") {
        label = "working tree";
        result = scanWorkingTree(root);
      } else if (mode === "history") {
        label = "history (all refs)";
        result = scanHistory(root);
      } else {
        const rel = args.dir ?? path.join("apps", "web", io.env.NEXT_DIST_DIR || ".next", "static");
        label = `client bundle ${rel.split(path.sep).join("/")}`;
        result = scanBundleDir(path.resolve(root, rel), root);
      }
    } catch (err) {
      io.error(`guard: ${(err as Error).message}`);
      return 2;
    }

    const findings = dedupe(result.findings);
    for (const f of findings) {
      io.log(formatFinding(f));
      if (annotate) io.log(githubAnnotation(f));
    }
    const unit = mode === "history" ? "blobs" : "files";
    const verdict = findings.length === 0 ? "clean" : `${findings.length} finding${findings.length === 1 ? "" : "s"}`;
    io.log(`guard: ${label}: ${result.scanned} ${unit} scanned, ${verdict}`);
    total += findings.length;
  }
  return total === 0 ? 0 : 1;
}
