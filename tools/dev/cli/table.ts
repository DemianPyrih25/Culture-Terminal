// Aligned plain-text tables for the dev CLIs. Widths count code points with combining marks as
// zero width, so names with accents and the glyphs the CLIs print (①, —, ✓) line up. Qloo names and
// LLM text are untrusted, so nothing here lets a control character reach the terminal.

/**
 * C0 and C1 controls (ESC opens terminal escape sequences: screen rewrites, OSC 8 links, OSC 52
 * clipboard writes), zero-width marks, line and paragraph separators, bidi overrides and isolates,
 * and the BOM.
 */
function isUnsafe(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

/** Tab, line feed, carriage return, line and paragraph separators: shown as a space. */
const isBreak = (cp: number): boolean => cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x2028 || cp === 0x2029;

function strip(s: string, keepLineFeed: boolean): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x0a && keepLineFeed) out += ch;
    else if (isBreak(cp)) out += " ";
    else if (!isUnsafe(cp)) out += ch;
  }
  return out;
}

/** Untrusted text as one line: tabs and line breaks become spaces, other control characters go. */
export function clean(s: string): string {
  return strip(s, false);
}

/** A line for the terminal: like {@link clean}, but line feeds (the CLIs' own blank lines) stay. */
export function terminalSafe(s: string): string {
  return strip(s, true);
}

export interface Column {
  header: string;
  align?: "left" | "right";
  /** Cells longer than this are cut with "…". */
  max?: number;
}

export interface TableOptions {
  /** Prefix of every line. */
  indent?: string;
  /** Spaces between columns (default 2). */
  gap?: number;
  /** Omit the header line. */
  noHeader?: boolean;
}

const COMBINING = /\p{M}/u;

export function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) if (!COMBINING.test(ch)) width += 1;
  return width;
}

/** Cut to `max` display columns, ending in "…" when cut. */
export function truncate(s: string, max: number): string {
  if (max < 1) return "";
  if (displayWidth(s) <= max) return s;
  let out = "";
  let width = 0;
  for (const ch of s) {
    const w = COMBINING.test(ch) ? 0 : 1;
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

/** Word-wrapped to `width` display columns; a word longer than the width gets a line of its own. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (line !== "" && displayWidth(line) + 1 + displayWidth(word) > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines.length === 0 ? [""] : lines;
}

export function padCell(s: string, width: number, align: "left" | "right" = "left"): string {
  const fill = " ".repeat(Math.max(0, width - displayWidth(s)));
  return align === "right" ? fill + s : s + fill;
}

/** The table as lines, trailing spaces trimmed. Missing cells render empty. */
export function renderTable(columns: readonly Column[], rows: readonly (readonly string[])[], options: TableOptions = {}): string[] {
  const indent = options.indent ?? "";
  const gap = " ".repeat(options.gap ?? 2);
  const cell = (row: readonly string[], i: number): string => {
    // Line breaks would split a row and controls would break the widths; leading spaces are kept,
    // since they can be alignment.
    const raw = clean(row[i] ?? "");
    const max = columns[i]?.max;
    return max === undefined ? raw : truncate(raw, max);
  };
  const body = rows.map((row) => columns.map((_, i) => cell(row, i)));
  const header = columns.map((c) => c.header);
  const all = options.noHeader ? body : [header, ...body];
  const widths = columns.map((_, i) => Math.max(0, ...all.map((r) => displayWidth(r[i] ?? ""))));
  return all.map((r) =>
    (indent + r.map((c, i) => padCell(c, widths[i] ?? 0, columns[i]?.align)).join(gap)).trimEnd(),
  );
}
