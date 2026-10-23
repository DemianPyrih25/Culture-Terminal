// The repository data rule (D29, PLAN §10.2): nothing that came out of Qloo, and no secret,
// may reach git. These rules run over the working tree (disk and index), over every blob in
// history, and over paths and commit and tag messages.
import { readFileSync } from "node:fs";
import path from "node:path";
import { decodeText, dedupe, lineAt, scanWithRules, type Finding, type RuleId, type TextRule } from "./finding";
import { INVISIBLE_CHAR } from "./invisible";
import {
  type BlobEntry,
  listCommitMessages,
  listHistoryEntries,
  listIndexBlobs,
  listTagMessages,
  listWorkingTreeFiles,
  readBlobs,
} from "./git";

const REQUEST_ID_HEADER = "x-qloo-request-id";

const PRIVATE_DIRS: ReadonlyArray<{ segments: readonly string[]; message: string }> = [
  { segments: [".probe"], message: ".probe/ holds raw Qloo probe responses and stays local (D29)" },
  { segments: [".private"], message: ".private/ holds private data and stays local (D29)" },
  { segments: ["eval", "raw"], message: "eval/raw/ holds raw eval transcripts and stays local (D29)" },
];

function hasSegments(segments: readonly string[], wanted: readonly string[]): boolean {
  for (let i = 0; i + wanted.length <= segments.length; i++) {
    if (wanted.every((w, j) => segments[i + j] === w)) return true;
  }
  return false;
}

export function checkPath(file: string): Finding[] {
  const segments = file.split("/");
  const base = segments[segments.length - 1] ?? "";
  const messages: string[] = [];
  for (const dir of PRIVATE_DIRS) {
    // A directory rule needs at least one path segment after the directory itself.
    if (hasSegments(segments.slice(0, -1), dir.segments)) messages.push(dir.message);
  }
  if (/\.(?:dump|backup|pgdump|sql\.gz)$/i.test(base)) messages.push("database dumps stay outside the repository (PLAN §3.2)");
  const envSegment = segments.some((s, i) => s.startsWith(".env") && !(i === segments.length - 1 && s === ".env.example"));
  if (envSegment) messages.push("environment files hold secrets; only .env.example is committed");
  return messages.map((message) => ({ file, rule: "forbidden-path", message }));
}

// drizzle-kit stamps every migration snapshot with random `id` and `prevId` UUIDs of its own.
// Only those two keys are exempt, and only in snapshot files; the SQL migrations are still scanned.
const DRIZZLE_SNAPSHOT = /^packages\/db\/drizzle\/meta\/\d+_snapshot\.json$/;
const DRIZZLE_SNAPSHOT_ID_LINE = /^\s*"(?:id|prevId)":\s*"[0-9a-f-]{36}",?\s*$/i;

function uuidRule(file: string): TextRule {
  return {
    id: "uuid",
    // A hex digit right before the UUID means a longer hex run, unless it ends an escape: %XX and
    // %uXXXX, also percent-encoded again (%252C, %25u201C), \xXX and \uXXXX. URL-encoded queries put
    // UUIDs right after %22, %2C or %3D (%253D once more when a URL rides inside another), and JSON
    // with escaped non-ASCII puts them right after " or “.
    pattern:
      /(?:(?<![0-9a-f])|(?<=(?:%(?:25)*(?:u[0-9a-f]{2})?|\\x|\\u[0-9a-f]{2})[0-9a-f]{2}))[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi,
    message: "UUID-shaped value outside **/test/synthetic/** (D29: Qloo IDs are resolved at runtime and pinned in the database)",
    accept: DRIZZLE_SNAPSHOT.test(file)
      ? (m, text) => !DRIZZLE_SNAPSHOT_ID_LINE.test(lineAt(text, m.index))
      : undefined,
  };
}

// The header name is fine on its own (code reads it); a value next to it is a real request id.
const REQUEST_ID: TextRule = {
  id: "request-id",
  pattern: new RegExp(`${REQUEST_ID_HEADER}["'\`]?[ \\t]*(?:=>|->|→|[:=|])?[ \\t]*["'\`]?([A-Za-z0-9][A-Za-z0-9_-]{7,})`, "gi"),
  message: `${REQUEST_ID_HEADER} followed by a value (D29: request ids live in the database ledger, never in git)`,
  accept: (m) => /\d/.test(m[1] ?? ""),
};

// Three or more fractional digits look like a copied Qloo score. Dotted sequences such as the
// semantic version 0.131.0 or an IP address are not decimals and are skipped. `_` may precede the
// number, so Markdown emphasis such as _0.9234_ is still caught.
const DECIMAL: TextRule = {
  id: "decimal",
  pattern: /(?<![A-Za-z0-9.])\d*\.\d{3,}(?!\.?\d)/g,
  message: "decimal with 3+ fractional digits in docs, prompts, config or page copy (D29: bind numbers at runtime or write them symbolically)",
};

const ANTHROPIC_KEY: TextRule = {
  id: "anthropic-key",
  pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
  message: "Anthropic API key",
};

const SYNTHETIC_FIXTURES = /(^|\/)test\/synthetic\//;

// Page copy lives in apps/web/content/** (any format), not inline in TSX: .tsx stays out of scope
// because its code constants would trip the rule, so prose belongs in the content folder.
export function inDecimalScope(file: string): boolean {
  return (
    file.startsWith("docs/") ||
    /(^|\/)readme\.mdx?$/i.test(file) ||
    file.startsWith("packages/agent/prompts/") ||
    file.startsWith("config/") ||
    file.startsWith("apps/web/content/") ||
    /^apps\/web\/app\/.+\.mdx?$/.test(file)
  );
}

export function rulesFor(file: string): TextRule[] {
  const rules: TextRule[] = [REQUEST_ID, ANTHROPIC_KEY, INVISIBLE_CHAR];
  if (!SYNTHETIC_FIXTURES.test(file)) rules.push(uuidRule(file));
  if (inDecimalScope(file)) rules.push(DECIMAL);
  return rules;
}

export function scanText(file: string, text: string): Finding[] {
  return scanWithRules(file, text, rulesFor(file));
}

/**
 * UUIDs and request ids in a path, e.g. a fixture named after a Qloo entity. The path holds the
 * value itself, so findings show it masked.
 */
export function checkPathText(file: string): Finding[] {
  if (SYNTHETIC_FIXTURES.test(file)) return [];
  const rules = [uuidRule(file), REQUEST_ID];
  const hits = scanWithRules(file, file, rules);
  if (hits.length === 0) return [];
  const masked = rules.reduce((shown, rule) => shown.replace(rule.pattern, `<${rule.id}>`), file);
  return hits.map((f) => ({ file: masked, rule: f.rule, message: `${f.message} (in the path)` }));
}

// Formats the repository holds on purpose. Any other file the guard cannot read is reported.
const KNOWN_BINARY = /\.(?:ico|png|jpe?g|gif|webp|woff2?|pen|pdf)$/i;

function scanDecoded(file: string, text: string | null): Finding[] {
  if (text !== null) return scanText(file, text);
  if (KNOWN_BINARY.test(file)) return [];
  return [{ file, rule: "binary", message: "unscannable binary file; commit it only if it holds no Qloo data" }];
}

export function scanContent(file: string, content: Buffer): Finding[] {
  return scanDecoded(file, decodeText(content));
}

export interface ScanResult {
  findings: Finding[];
  scanned: number;
}

/** Reads each distinct blob once and hands its decoded text to every entry that uses it. Returns the blob count. */
function readEntries<E extends BlobEntry>(
  root: string,
  entries: readonly E[],
  onEntry: (entry: E, text: string | null) => void,
): number {
  const byBlob = new Map<string, E[]>();
  for (const e of entries) {
    const list = byBlob.get(e.blob);
    if (list) list.push(e);
    else byBlob.set(e.blob, [e]);
  }
  readBlobs(root, [...byBlob.keys()], (sha, content) => {
    const text = decodeText(content);
    for (const e of byBlob.get(sha) ?? []) onEntry(e, text);
  });
  return byBlob.size;
}

export function scanWorkingTree(root: string): ScanResult {
  const files = listWorkingTreeFiles(root);
  const findings: Finding[] = [];
  for (const file of files) {
    findings.push(...checkPath(file), ...checkPathText(file));
    let content: Buffer;
    try {
      content = readFileSync(path.join(root, file));
    } catch {
      // Deleted but still in the index, or a submodule directory: the staged blob is scanned below.
      continue;
    }
    findings.push(...scanContent(file, content));
  }
  // The staged blob is what the next commit records. It differs from the disk when a file was
  // edited after `git add`, or deleted on disk while still staged.
  readEntries(root, listIndexBlobs(root), (e, text) => findings.push(...scanDecoded(e.path, text)));
  return { findings: dedupe(findings), scanned: files.length };
}

// Source hygiene, not data: enforced on the working tree and index, where it can still be fixed. History
// keeps what was committed (rewriting it needs a force-push), so only the data rules apply there.
const HYGIENE_RULES: ReadonlySet<RuleId> = new Set<RuleId>(["invisible-char"]);

export function scanHistory(root: string): ScanResult {
  const entries = listHistoryEntries(root);
  const findings: Finding[] = [];
  const reportedPaths = new Set<string>();
  for (const e of entries) {
    if (reportedPaths.has(e.path)) continue;
    reportedPaths.add(e.path);
    findings.push(...[...checkPath(e.path), ...checkPathText(e.path)].map((f) => ({ ...f, commit: e.commit })));
  }
  const scanned = readEntries(root, entries, (e, text) => {
    findings.push(...scanDecoded(e.path, text).filter((f) => !HYGIENE_RULES.has(f.rule)).map((f) => ({ ...f, commit: e.commit })));
  });

  // Messages are published with the history, so they follow the same rule as file contents.
  const messages = [
    ...listCommitMessages(root).map((m) => ({ ...m, label: "<commit message>" })),
    ...listTagMessages(root).map((m) => ({ ...m, label: "<tag message>" })),
  ];
  for (const { label, sha, message } of messages) {
    const rules = [uuidRule(label), REQUEST_ID, ANTHROPIC_KEY];
    findings.push(...scanWithRules(label, message, rules).map((f) => ({ ...f, commit: sha })));
  }
  return { findings, scanned };
}
