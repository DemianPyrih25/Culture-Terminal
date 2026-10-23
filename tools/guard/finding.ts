import { gunzipSync } from "node:zlib";

export type RuleId =
  | "forbidden-path"
  | "binary"
  | "uuid"
  | "request-id"
  | "decimal"
  | "anthropic-key"
  | "invisible-char"
  | "bundle-secret";

export interface Finding {
  /** Forward-slash path relative to the repository root. */
  file: string;
  line?: number;
  column?: number;
  rule: RuleId;
  /** Never contains the matched value: guard output lands in public CI logs. */
  message: string;
  /** History mode only: a commit that introduced the blob at this path, or the commit or tag whose message matched. */
  commit?: string;
}

/** Same heuristic as git: a NUL byte in the first 8000 bytes means binary. */
export function isBinary(buf: Uint8Array): boolean {
  const end = Math.min(buf.length, 8000);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
}

// A gzip that inflates past this is reported as unreadable rather than held in memory.
const MAX_GUNZIP_BYTES = 64 * 1024 * 1024;

/** UTF-16LE without a BOM: mostly-ASCII text has a NUL in nearly every odd byte and none in even ones. */
function looksUtf16le(buf: Buffer): boolean {
  const end = Math.min(buf.length, 8000) & ~1;
  let oddNul = 0;
  let evenNul = 0;
  for (let i = 0; i < end; i += 2) {
    if (buf[i] === 0) evenNul++;
    if (buf[i + 1] === 0) oddNul++;
  }
  const pairs = end / 2;
  return pairs > 0 && oddNul * 2 > pairs && evenNul * 10 < pairs;
}

/**
 * The text the rules should read, or null when the content is binary. A NUL byte alone must not
 * hide data: Windows PowerShell 5.1 writes UTF-16LE for `>` and Out-File, and gzip is inflated.
 */
export function decodeText(content: Uint8Array, depth = 0): string | null {
  const buf = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    return Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))).swap16().toString("utf16le");
  }
  if (buf[0] === 0x1f && buf[1] === 0x8b && depth < 3) {
    try {
      return decodeText(gunzipSync(buf, { maxOutputLength: MAX_GUNZIP_BYTES }), depth + 1);
    } catch {
      // Not a valid gzip stream (or too large): judged like any other content below.
    }
  }
  if (!isBinary(buf)) return buf.toString("utf8");
  return looksUtf16le(buf) ? buf.toString("utf16le") : null;
}

/** Maps a string index to a 1-based line and column. */
export function lineLocator(text: string): (index: number) => { line: number; column: number } {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: index - (starts[lo] ?? 0) + 1 };
  };
}

export interface TextRule {
  id: RuleId;
  /** Must carry the g flag. */
  pattern: RegExp;
  message: string;
  /** Extra check on a raw match, for rules a regex alone cannot express cleanly. */
  accept?: (match: RegExpExecArray, text: string) => boolean;
}

export function scanWithRules(file: string, text: string, rules: readonly TextRule[]): Finding[] {
  const findings: Finding[] = [];
  let locate: ReturnType<typeof lineLocator> | undefined;
  for (const rule of rules) {
    for (const match of text.matchAll(rule.pattern)) {
      if (rule.accept && !rule.accept(match, text)) continue;
      locate ??= lineLocator(text);
      findings.push({ file, ...locate(match.index), rule: rule.id, message: rule.message });
    }
  }
  return findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));
}

/** Drops repeated findings (same file, position, rule and message), keeping the first. */
export function dedupe(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.file}|${f.line}|${f.column}|${f.rule}|${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The full line containing `index`, without its line break. */
export function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end).replace(/\r$/, "");
}

export function formatFinding(f: Finding): string {
  const where = f.line === undefined ? f.file : `${f.file}:${f.line}:${f.column ?? 1}`;
  const origin = f.commit ? ` (commit ${f.commit.slice(0, 12)})` : "";
  return `${where}  ${f.rule}  ${f.message}${origin}`;
}

function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** A GitHub Actions workflow command, so findings show up on the pull request diff. */
export function githubAnnotation(f: Finding): string {
  const props = [`file=${escapeProperty(f.file)}`, `title=${escapeProperty(`guard ${f.rule}`)}`];
  if (f.line !== undefined) props.push(`line=${f.line}`, `col=${f.column ?? 1}`);
  const origin = f.commit ? ` (commit ${f.commit.slice(0, 12)})` : "";
  return `::error ${props.join(",")}::${escapeData(f.message + origin)}`;
}
