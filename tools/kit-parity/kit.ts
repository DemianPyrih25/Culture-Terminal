// The Qloo kit CLI side of the parity check: `qloo api search --query <name> --type <urn> --take <n>
// --json`, the same /search our side sends, run as a child process. Only kit-parity's --live-kit
// path calls it; tests pass a fake runner, or a fake spawn to the real one.
import { spawn, type SpawnOptions } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

/** One /search as both sides send it. */
export interface KitSearch {
  query: string;
  /** Entity type URN. */
  types: string;
  take: number;
}

export interface KitRun {
  /** The command line as shown to people. */
  command: string;
  /** True once the process started, so it may have spent a live Qloo call. */
  spawned: boolean;
  /** Exit status, or null when the process could not start or was killed. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Why the process failed to start or finish, if it did. */
  error: string | null;
  ms: number;
}

export type KitRunner = (search: KitSearch) => Promise<KitRun>;

/** The parts of a child process the runner uses. */
export interface KitProcess {
  readonly pid?: number | undefined;
  readonly stdout: KitPipe | null;
  readonly stderr: KitPipe | null;
  on(event: "spawn", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit" | "close", listener: (status: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface KitPipe {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  destroy(): unknown;
}

export type SpawnKit = (command: string, args: readonly string[], options: SpawnOptions) => KitProcess;

export interface KitRunnerOptions {
  platform?: NodeJS.Platform;
  /** PATH and PATHEXT for finding the binary on Windows. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
  timeoutMs?: number;
  /** How long the output pipes may stay open after the process exits or is killed. */
  drainMs?: number;
  /** Starts the kit, and on Windows taskkill (tests pass a fake). */
  spawn?: SpawnKit;
}

const KIT_TIMEOUT_MS = 60_000;
const KIT_DRAIN_MS = 2_000;
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export function kitArgs(search: KitSearch): string[] {
  return ["api", "search", "--query", search.query, "--type", search.types, "--take", String(search.take), "--json"];
}

/**
 * One argument for cmd.exe. npm-installed CLIs are .cmd shims on Windows, which Node starts only
 * through a shell, so arguments are quoted here; inside double quotes cmd.exe still expands %VAR%,
 * and a quote would end the argument, so names with either are refused.
 */
export function cmdQuote(arg: string): string {
  if (/["%\r\n]/.test(arg)) throw new Error(`cannot pass ${JSON.stringify(arg)} to the kit through cmd.exe: it contains a quote, % or a line break`);
  return `"${arg}"`;
}

export function displayCommand(bin: string, search: KitSearch): string {
  return [bin, ...kitArgs(search).map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" ");
}

/** An environment variable by name in any case, as Windows reads them (Path, PATH). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

const isFile = (file: string): boolean => statSync(file, { throwIfNoEntry: false })?.isFile() === true;

/**
 * The file cmd.exe would run for `bin`: a name with a directory is looked up as given, a bare name
 * in the current directory and then each PATH entry, with each PATHEXT extension unless the name has
 * one of its own. Null when cmd.exe would not find it.
 */
export function findOnWindowsPath(bin: string, env: NodeJS.ProcessEnv, cwd: string): string | null {
  const exts = (envValue(env, "PATHEXT") ?? DEFAULT_PATHEXT).split(";").filter((e) => e !== "");
  const names = [...(path.extname(bin) === "" ? [] : [bin]), ...exts.map((e) => `${bin}${e}`)];
  const dirs = /[\\/]/.test(bin)
    ? [cwd]
    : [cwd, ...(envValue(env, "PATH") ?? "").split(";").map((d) => d.replace(/"/g, "").trim()).filter((d) => d !== "")];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.resolve(dir, name);
      if (isFile(file)) return file;
    }
  }
  return null;
}

const defaultSpawn: SpawnKit = (command, args, options) => (args.length === 0 ? spawn(command, options) : spawn(command, [...args], options));

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function spawnKitRunner(bin: string, options: KitRunnerOptions = {}): KitRunner {
  const windows = (options.platform ?? process.platform) === "win32";
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? KIT_TIMEOUT_MS;
  const drainMs = options.drainMs ?? KIT_DRAIN_MS;
  const spawnKit = options.spawn ?? defaultSpawn;

  // child.kill would end only cmd.exe on Windows: the kit it started would run on and hold the pipes.
  const killTree = (child: KitProcess): void => {
    if (!windows || child.pid === undefined) {
      child.kill();
      return;
    }
    try {
      const killer = spawnKit("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => child.kill());
    } catch {
      child.kill();
    }
  };

  return (search) =>
    new Promise((resolve) => {
      const command = displayCommand(bin, search);
      const started = now();
      const notStarted = (error: string): void => resolve({ command, spawned: false, status: null, stdout: "", stderr: "", error, ms: now() - started });
      let windowsLine = "";
      if (windows) {
        try {
          windowsLine = [bin, ...kitArgs(search)].map(cmdQuote).join(" ");
        } catch (err) {
          notStarted(errorText(err));
          return;
        }
        // cmd.exe starts whether or not the kit exists (it prints "is not recognized" and exits 1), so
        // a missing kit would count as a live call: look it up first.
        if (findOnWindowsPath(bin, env, options.cwd ?? process.cwd()) === null) {
          notStarted(`${bin} was not found in the current directory or on PATH`);
          return;
        }
      }
      // On Windows the quoted line goes to the shell whole: Node deprecates passing args with shell: true.
      let child: KitProcess;
      try {
        child = windows ? spawnKit(windowsLine, [], { windowsHide: true, shell: true }) : spawnKit(bin, kitArgs(search), { windowsHide: true });
      } catch (err) {
        notStarted(errorText(err));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let spawned = false;
      let settled = false;
      let timedOut = false;
      let exit: { status: number | null; signal: NodeJS.Signals | null } | null = null;
      let drain: NodeJS.Timeout | undefined;
      const finish = (status: number | null, error: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(drain);
        resolve({
          command,
          spawned,
          status,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          error,
          ms: now() - started,
        });
      };
      const finishExited = (): void => {
        const signal = exit?.signal ?? null;
        finish(exit?.status ?? null, timedOut ? `timed out after ${timeoutMs} ms` : signal === null ? null : `killed by ${signal}`);
      };
      // Once the process exits or is killed, its pipes get drainMs to close: on Windows a process the
      // shell started can outlive it and hold them open.
      const startDrain = (): void => {
        if (drain !== undefined || settled) return;
        drain = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finishExited();
        }, drainMs);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        startDrain();
      }, timeoutMs);
      child.on("spawn", () => {
        spawned = true;
      });
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      // A process that cannot start reports only "error"; one that ran reports "exit", then "close"
      // once its pipes are done.
      child.on("error", (err) => finish(null, err.message));
      child.on("exit", (status, signal) => {
        exit = { status, signal };
        startDrain();
      });
      child.on("close", (status, signal) => {
        exit ??= { status, signal };
        finishExited();
      });
    });
}
