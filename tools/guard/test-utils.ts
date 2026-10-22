// Test helpers for the guard. Every "bad" value is assembled at runtime, so the repository never
// holds a literal UUID, request id or key (and the guard can scan its own tests).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A UUID-shaped string built from one hex digit, e.g. fakeUuid("c"). */
export function fakeUuid(hex = "c"): string {
  return [8, 4, 4, 4, 12].map((n) => hex.repeat(n)).join("-");
}

export const REQUEST_ID_HEADER = ["x", "qloo", "request", "id"].join("-");

/** A request-id-shaped value: hex with digits. */
export function fakeRequestId(): string {
  return "a1b2".repeat(6);
}

export function fakeAnthropicKey(): string {
  return ["sk", "ant", "api03", "Z9".repeat(24)].join("-");
}

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `ct-guard-${prefix}-`));
}

export function writeFiles(root: string, files: Record<string, string | Uint8Array>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/**
 * A throwaway repository in the OS temp directory. Commits are built with plumbing commands and a
 * private index, so the user's git config, hooks and working index are never involved.
 */
export class TempRepo {
  readonly root: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor() {
    this.root = tempDir("repo");
    const emptyConfig = path.join(this.root, "..", `${path.basename(this.root)}.gitconfig`);
    writeFileSync(emptyConfig, "");
    this.env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_AUTHOR_NAME: "Guard Test",
      GIT_AUTHOR_EMAIL: "guard-test@example.invalid",
      GIT_COMMITTER_NAME: "Guard Test",
      GIT_COMMITTER_EMAIL: "guard-test@example.invalid",
      GIT_TERMINAL_PROMPT: "0",
    };
    this.git(["init", "-q", "-b", "main"]);
  }

  git(args: readonly string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}): string {
    const res = spawnSync("git", args, { cwd: this.root, input, env: { ...this.env, ...extraEnv } });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
    return res.stdout.toString("utf8").trim();
  }

  write(files: Record<string, string | Uint8Array>): void {
    writeFiles(this.root, files);
  }

  /** Records a commit whose tree is exactly `files`, and points `ref` at it. */
  commit(files: Record<string, string>, message: string, parent?: string, ref = "refs/heads/main"): string {
    const indexFile = path.join(this.root, ".git", "guard-test-index");
    rmSync(indexFile, { force: true });
    const env = { GIT_INDEX_FILE: indexFile };
    for (const [rel, content] of Object.entries(files)) {
      const blob = this.git(["hash-object", "-w", "--stdin"], content);
      this.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${rel}`], undefined, env);
    }
    const tree = this.git(["write-tree"], undefined, env);
    const args = ["commit-tree", tree, "-m", message];
    if (parent) args.push("-p", parent);
    const sha = this.git(args);
    this.git(["update-ref", ref, sha]);
    return sha;
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
    rmSync(path.join(this.root, "..", `${path.basename(this.root)}.gitconfig`), { force: true });
  }
}
