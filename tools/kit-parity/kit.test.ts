// The kit runner with a fake spawn: no process starts and nothing touches the network. The Windows
// paths run on any platform, since the platform, PATH and the spawn are all passed in.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findOnWindowsPath, spawnKitRunner, type KitProcess, type KitSearch, type SpawnKit } from "./kit";

const SEARCH: KitSearch = { query: "Brand Alpha", types: "urn:entity:brand", take: 5 };
// Lower case, so the files below are found on case-sensitive file systems too.
const PATHEXT = ".com;.exe;.bat;.cmd";

class FakeChild extends EventEmitter implements KitProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killed: (NodeJS.Signals | undefined)[] = [];
  constructor(readonly pid: number) {
    super();
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal);
    return true;
  }
}

/** A spawn that records each command and hands back a child the test drives. */
function fakeSpawn() {
  const calls: { command: string; args: readonly string[]; child: FakeChild }[] = [];
  const spawn: SpawnKit = (command, args) => {
    const child = new FakeChild(4200 + calls.length);
    calls.push({ command, args, child });
    return child;
  };
  const child = (i: number): FakeChild => {
    const call = calls[i];
    if (call === undefined) throw new Error(`no spawn #${i}`);
    return call.child;
  };
  return { spawn, calls, child };
}

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new directory holding an empty file for each name. */
function binDir(...names: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-kit-"));
  dirs.push(dir);
  for (const name of names) writeFileSync(path.join(dir, name), "");
  return dir;
}

/** Windows, with the kit installed as an npm .cmd shim on PATH. */
const windowsWithKit = () => ({ platform: "win32" as const, env: { PATH: binDir("qloo.cmd"), PATHEXT }, cwd: binDir() });

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("findOnWindowsPath", () => {
  it("finds a bare name on PATH with a PATHEXT extension, whatever the case of the variable names", () => {
    const dir = binDir("qloo.cmd");
    const empty = binDir();
    expect(findOnWindowsPath("qloo", { Path: `${empty};"${dir}"`, PathExt: PATHEXT }, empty)).toBe(path.join(dir, "qloo.cmd"));
  });

  it("looks in the current directory first, and takes a name with its own extension as given", () => {
    const cwd = binDir("qloo.bat", "kit.exe");
    expect(findOnWindowsPath("qloo", { PATH: binDir("qloo.cmd"), PATHEXT }, cwd)).toBe(path.join(cwd, "qloo.bat"));
    expect(findOnWindowsPath("kit.exe", { PATH: "", PATHEXT }, cwd)).toBe(path.join(cwd, "kit.exe"));
  });

  it("returns null for a missing binary or one without a PATHEXT extension", () => {
    expect(findOnWindowsPath("qloo", { PATH: binDir("other.cmd"), PATHEXT }, binDir())).toBeNull();
    // npm also writes an extensionless shell script, which cmd.exe cannot run.
    expect(findOnWindowsPath("qloo", { PATH: binDir("qloo"), PATHEXT }, binDir())).toBeNull();
  });

  it("resolves a name with a directory against the current directory only", () => {
    const cwd = binDir();
    mkdirSync(path.join(cwd, "bin"));
    writeFileSync(path.join(cwd, "bin", "qloo.cmd"), "");
    expect(findOnWindowsPath("bin/qloo", { PATH: binDir("qloo.cmd"), PATHEXT }, cwd)).toBe(path.join(cwd, "bin", "qloo.cmd"));
    expect(findOnWindowsPath("other/qloo", { PATH: binDir("qloo.cmd"), PATHEXT }, cwd)).toBeNull();
  });
});

describe("spawnKitRunner on Windows", () => {
  it("does not start cmd.exe when the kit is not on PATH, so no live call is counted", async () => {
    const fake = fakeSpawn();
    const run = spawnKitRunner("qloo", { platform: "win32", env: { PATH: binDir(), PATHEXT }, cwd: binDir(), spawn: fake.spawn });
    const result = await run(SEARCH);
    expect(fake.calls).toEqual([]);
    expect(result).toMatchObject({ spawned: false, status: null, error: "qloo was not found in the current directory or on PATH" });
  });

  it("runs the quoted line through the shell and reads the output", async () => {
    const fake = fakeSpawn();
    const pending = spawnKitRunner("qloo", { ...windowsWithKit(), spawn: fake.spawn })(SEARCH);
    expect(fake.calls[0]).toMatchObject({ command: '"qloo" "api" "search" "--query" "Brand Alpha" "--type" "urn:entity:brand" "--take" "5" "--json"', args: [] });
    const child = fake.child(0);
    child.emit("spawn");
    child.stdout.write("[]");
    await flush();
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
    expect(await pending).toMatchObject({ spawned: true, status: 0, stdout: "[]", error: null });
  });

  it("ends a hung kit at the timeout by killing the process tree, even while a grandchild holds the pipes", async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn();
    const pending = spawnKitRunner("qloo", { ...windowsWithKit(), spawn: fake.spawn, timeoutMs: 1_000, drainMs: 100 })(SEARCH);
    const child = fake.child(0);
    child.emit("spawn");
    await vi.advanceTimersByTimeAsync(1_000);
    // taskkill /T ends cmd.exe and the kit under it; child.kill would end cmd.exe only.
    expect(fake.calls[1]).toMatchObject({ command: "taskkill", args: ["/T", "/F", "/PID", String(child.pid)] });
    expect(child.killed).toEqual([]);
    // cmd.exe exits, but "close" never comes, as when the kit's node process keeps the pipes.
    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ spawned: true, status: 1, error: "timed out after 1000 ms" });
    expect(child.stdout.destroyed).toBe(true);
  });

  it("settles shortly after the kit exits when its pipes stay open", async () => {
    const fake = fakeSpawn();
    const pending = spawnKitRunner("qloo", { ...windowsWithKit(), spawn: fake.spawn, drainMs: 10 })(SEARCH);
    const child = fake.child(0);
    child.emit("spawn");
    child.stdout.write('{"results":[]}');
    await flush();
    child.emit("exit", 0, null);
    expect(await pending).toMatchObject({ spawned: true, status: 0, stdout: '{"results":[]}', error: null });
    expect(child.stdout.destroyed).toBe(true);
  });
});

describe("spawnKitRunner elsewhere", () => {
  it("passes the arguments without a shell and reports a binary that cannot start as not spawned", async () => {
    const fake = fakeSpawn();
    const pending = spawnKitRunner("qloo", { platform: "linux", spawn: fake.spawn })(SEARCH);
    expect(fake.calls[0]).toMatchObject({ command: "qloo", args: ["api", "search", "--query", "Brand Alpha", "--type", "urn:entity:brand", "--take", "5", "--json"] });
    fake.child(0).emit("error", new Error("spawn qloo ENOENT"));
    expect(await pending).toMatchObject({ spawned: false, status: null, error: "spawn qloo ENOENT" });
  });

  it("kills the kit itself at the timeout", async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn();
    const pending = spawnKitRunner("qloo", { platform: "linux", spawn: fake.spawn, timeoutMs: 1_000, drainMs: 100 })(SEARCH);
    const child = fake.child(0);
    child.emit("spawn");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.killed).toEqual([undefined]);
    expect(fake.calls).toHaveLength(1);
    child.emit("exit", null, "SIGTERM");
    child.emit("close", null, "SIGTERM");
    expect(await pending).toMatchObject({ spawned: true, status: null, error: "timed out after 1000 ms" });
  });
});
