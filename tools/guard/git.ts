import { spawnSync } from "node:child_process";

const MAX_BUFFER = 1024 * 1024 * 1024;
const ZERO_SHA = /^0+$/;
const SUBMODULE_MODE = "160000";

export function git(root: string, args: readonly string[], input?: string): Buffer {
  const res = spawnSync("git", args, { cwd: root, input, maxBuffer: MAX_BUFFER });
  if (res.error) throw new Error(`git ${args[0]} could not start: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited with ${res.status}: ${res.stderr.toString().trim()}`);
  }
  return res.stdout;
}

/** Every file git would pick up for a commit: tracked plus untracked-but-not-ignored. */
export function listWorkingTreeFiles(root: string): string[] {
  const out = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).toString("utf8");
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

export interface BlobEntry {
  path: string;
  blob: string;
}

/**
 * The staged blob of every index entry (all merge stages), skipping submodules. This is what the
 * next commit records, and it can differ from the file on disk.
 */
export function listIndexBlobs(root: string): BlobEntry[] {
  const out = git(root, ["ls-files", "-s", "-z"]).toString("utf8");
  const entries: BlobEntry[] = [];
  for (const record of out.split("\0")) {
    // "<mode> <sha> <stage>\t<path>"
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, sha] = record.slice(0, tab).split(" ");
    if (!sha || mode === SUBMODULE_MODE) continue;
    entries.push({ path: record.slice(tab + 1), blob: sha });
  }
  return entries;
}

export interface HistoryEntry extends BlobEntry {
  commit: string;
}

/** False for a repository with no commits and no refs, where `git log --all` has nothing to show. */
function hasHistory(root: string): boolean {
  const hasCommits = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root }).status === 0;
  return hasCommits || git(root, ["for-each-ref", "--format=%(refname)"]).toString("utf8").trim() !== "";
}

/**
 * Every (path, blob) pair that any commit reachable from any ref introduced. Merges are diffed
 * against each parent, so a file that only ever existed in a merge result is still seen.
 */
export function listHistoryEntries(root: string): HistoryEntry[] {
  if (!hasHistory(root)) return [];

  const out = git(root, [
    "log",
    "--all",
    // Explicit so a user's log/diff config cannot change what is listed or how it is printed.
    "--root",
    "--no-color",
    "--no-show-signature",
    "--diff-merges=separate",
    "--no-renames",
    "--raw",
    "--no-abbrev",
    "-z",
    "--format=%x01%H",
  ]).toString("utf8");

  const entries: HistoryEntry[] = [];
  const seen = new Set<string>();
  const tokens = out.split("\0");
  let commit = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = (tokens[i] ?? "").replace(/^\n+/, "");
    if (token.startsWith("\x01")) {
      commit = token.slice(1).trim();
      continue;
    }
    if (!token.startsWith(":")) continue;
    // ":<src mode> <dst mode> <src sha> <dst sha> <status>" followed by the path token.
    const [, dstMode, , dstSha, status] = token.slice(1).split(" ");
    const path = tokens[++i] ?? "";
    if (!dstSha || ZERO_SHA.test(dstSha) || status === "D" || dstMode === SUBMODULE_MODE || !path) continue;
    const key = `${dstSha}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ path, blob: dstSha, commit });
  }
  return entries;
}

export interface ObjectMessage {
  /** The commit, or the annotated tag object. */
  sha: string;
  message: string;
}

/** The full message of every commit reachable from any ref. */
export function listCommitMessages(root: string): ObjectMessage[] {
  if (!hasHistory(root)) return [];
  const out = git(root, ["log", "--all", "--no-color", "--no-show-signature", "-z", "--format=%H%x01%B"]);
  return splitRecords(out.toString("utf8"), 2).map(([sha = "", message = ""]) => ({ sha, message }));
}

/** The message of every annotated tag. A lightweight tag has none of its own (its commit is listed above). */
export function listTagMessages(root: string): ObjectMessage[] {
  const out = git(root, ["for-each-ref", "refs/tags", "--format=%(objecttype)%01%(objectname)%01%(contents)%00"]);
  return splitRecords(out.toString("utf8"), 3)
    .filter(([type]) => type === "tag")
    .map(([, sha = "", message = ""]) => ({ sha, message }));
}

/**
 * Splits NUL-terminated records into `fields` fields separated by \x01. Git refuses NUL in commit
 * and tag messages, and the message is the last field, so a \x01 inside it stays in it.
 */
function splitRecords(out: string, fields: number): string[][] {
  return out
    .split("\0")
    .map((record) => record.replace(/^\n/, ""))
    .filter(Boolean)
    .map((record) => {
      const parts = record.split("\x01");
      return [...parts.slice(0, fields - 1), parts.slice(fields - 1).join("\x01")];
    });
}

/** Streams blob contents through one `git cat-file --batch` per chunk of ids. */
export function readBlobs(root: string, shas: readonly string[], onBlob: (sha: string, content: Buffer) => void): void {
  const CHUNK = 500;
  for (let start = 0; start < shas.length; start += CHUNK) {
    const chunk = shas.slice(start, start + CHUNK);
    const out = git(root, ["cat-file", "--batch"], chunk.join("\n") + "\n");
    let pos = 0;
    while (pos < out.length) {
      const headerEnd = out.indexOf(0x0a, pos);
      if (headerEnd === -1) break;
      const [sha = "", type = "", sizeText = ""] = out.subarray(pos, headerEnd).toString("utf8").split(" ");
      if (type === "missing") {
        pos = headerEnd + 1;
        continue;
      }
      const size = Number(sizeText);
      const content = out.subarray(headerEnd + 1, headerEnd + 1 + size);
      pos = headerEnd + 1 + size + 1;
      if (type === "blob") onBlob(sha, content);
    }
  }
}
