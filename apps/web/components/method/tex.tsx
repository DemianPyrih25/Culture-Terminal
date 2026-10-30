import { Fragment, type ReactNode } from "react";
import { cx } from "../ui/cx";

/**
 * A small TeX reader for the FORMULAS registry (formula_tex): enough of math mode to print every
 * formula on /method as typeset HTML (stacked fractions, scripts, roots, accents) with no math library
 * in the bundle. Anything it does not know prints as its source, so a test can catch it. A plain-text
 * reading of the same tree is what screen readers hear.
 */

export type TexNode =
  | { kind: "text"; text: string; italic: boolean }
  /** A large operator such as Σ. */
  | { kind: "op"; text: string }
  | { kind: "frac"; num: TexNode[]; den: TexNode[]; small: boolean }
  | { kind: "sqrt"; body: TexNode[] }
  | { kind: "accent"; mark: Accent; body: TexNode[] }
  | { kind: "script"; base: TexNode[]; sub: TexNode[] | null; sup: TexNode[] | null }
  | { kind: "group"; body: TexNode[] }
  /** \quad at the top level: where a formula with several clauses may wrap. */
  | { kind: "break" };

type Accent = "bar" | "tilde" | "hat";

type Token =
  | { t: "cmd"; name: string }
  | { t: "open" }
  | { t: "close" }
  | { t: "sub" }
  | { t: "sup" }
  | { t: "space" }
  | { t: "char"; ch: string };

/** math: letters italic, as TeX sets variables; upright: \mathrm and \operatorname; text: \text, spaces kept. */
type Mode = "math" | "upright" | "text";

const SYMBOLS: Readonly<Record<string, string>> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  Delta: "Δ",
  epsilon: "ε",
  theta: "θ",
  lambda: "λ",
  Lambda: "Λ",
  mu: "μ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  Sigma: "Σ",
  tau: "τ",
  phi: "φ",
  Phi: "Φ",
  chi: "χ",
  omega: "ω",
  Omega: "Ω",
  cdot: "·",
  times: "×",
  pm: "±",
  ge: "≥",
  geq: "≥",
  le: "≤",
  leq: "≤",
  ne: "≠",
  neq: "≠",
  approx: "≈",
  in: "∈",
  notin: "∉",
  iff: "⇔",
  Rightarrow: "⇒",
  implies: "⇒",
  to: "→",
  rightarrow: "→",
  wedge: "∧",
  land: "∧",
  vee: "∨",
  lor: "∨",
  mid: "|",
  lvert: "|",
  rvert: "|",
  lVert: "‖",
  rVert: "‖",
  infty: "∞",
  lceil: "⌈",
  rceil: "⌉",
  lfloor: "⌊",
  rfloor: "⌋",
  ldots: "…",
  dots: "…",
  cdots: "⋯",
  langle: "⟨",
  rangle: "⟩",
  cup: "∪",
  cap: "∩",
  subset: "⊂",
  subseteq: "⊆",
  setminus: "∖",
  emptyset: "∅",
  prime: "′",
  partial: "∂",
  forall: "∀",
  exists: "∃",
  neg: "¬",
};

const LARGE_OPERATORS: Readonly<Record<string, string>> = { sum: "Σ", prod: "Π" };

/** Escaped characters: \{ \} \# \_ \% \& \$ and \| (a double bar). */
const ESCAPES: Readonly<Record<string, string>> = { "{": "{", "}": "}", "#": "#", _: "_", "%": "%", "&": "&", $: "$", "|": "‖" };

/** Spacing commands; \! is a negative thin space and prints nothing. */
const SPACES: Readonly<Record<string, string>> = { " ": " ", ",": " ", ";": " ", ":": " ", "!": "" };

/** Named operators, set upright like \max. */
const OPERATORS: ReadonlySet<string> = new Set(["max", "min", "exp", "ln", "log", "arg", "sgn", "sup", "inf", "lim", "det", "Pr"]);

/** Size and style commands that change nothing here. */
const IGNORED: ReadonlySet<string> = new Set([
  "big",
  "Big",
  "bigg",
  "Bigg",
  "bigl",
  "bigr",
  "Bigl",
  "Bigr",
  "biggl",
  "biggr",
  "left",
  "right",
  "displaystyle",
  "textstyle",
  "limits",
  "nolimits",
]);

const ACCENTS: Readonly<Record<string, Accent>> = {
  bar: "bar",
  overline: "bar",
  tilde: "tilde",
  widetilde: "tilde",
  hat: "hat",
  widehat: "hat",
};

/** The combining marks, built from their code points so no invisible character sits in this file. */
const COMBINING: Readonly<Record<Accent, string>> = {
  bar: String.fromCharCode(0x304),
  tilde: String.fromCharCode(0x303),
  hat: String.fromCharCode(0x302),
};

function tokenize(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\") {
      const word = /^[A-Za-z]+/.exec(source.slice(i + 1));
      if (word) {
        out.push({ t: "cmd", name: word[0] });
        i += 1 + word[0].length;
      } else if (i + 1 < source.length) {
        out.push({ t: "cmd", name: source[i + 1]! });
        i += 2;
      } else {
        out.push({ t: "char", ch });
        i += 1;
      }
      continue;
    }
    if (ch === "{") out.push({ t: "open" });
    else if (ch === "}") out.push({ t: "close" });
    else if (ch === "_") out.push({ t: "sub" });
    else if (ch === "^") out.push({ t: "sup" });
    else if (/\s/.test(ch)) {
      if (out.at(-1)?.t !== "space") out.push({ t: "space" });
    } else out.push({ t: "char", ch });
    i += 1;
  }
  return out;
}

/** Appends text, merged into the previous run when it has the same style. */
function pushText(out: TexNode[], text: string, italic: boolean): void {
  if (text === "") return;
  const last = out.at(-1);
  if (last?.kind === "text" && last.italic === italic) last.text += text;
  else out.push({ kind: "text", text, italic });
}

function pushChar(out: TexNode[], ch: string, mode: Mode): void {
  if (mode === "text") return pushText(out, ch, false);
  if (/[A-Za-z]/.test(ch)) return pushText(out, ch, mode === "math");
  if (ch === "-") return pushText(out, "−", false);
  if (ch === "'") return pushText(out, "′", false);
  pushText(out, ch, false);
}

class Parser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): TexNode[] {
    return this.list("math", false);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private list(mode: Mode, untilClose: boolean): TexNode[] {
    const out: TexNode[] = [];
    while (this.pos < this.tokens.length) {
      const tok = this.tokens[this.pos]!;
      this.pos += 1;
      if (tok.t === "close") {
        if (untilClose) return out;
        continue;
      }
      this.token(tok, mode, out);
    }
    return out;
  }

  private group(mode: Mode): TexNode[] {
    this.depth += 1;
    const body = this.list(mode, true);
    this.depth -= 1;
    return body;
  }

  private token(tok: Exclude<Token, { t: "close" }>, mode: Mode, out: TexNode[]): void {
    switch (tok.t) {
      case "open":
        out.push({ kind: "group", body: this.group(mode) });
        return;
      case "sub":
      case "sup":
        return this.script(out, tok.t, this.argument(mode === "text" ? "math" : mode));
      case "space":
        return pushText(out, " ", false);
      case "char":
        return pushChar(out, tok.ch, mode);
      case "cmd":
        return this.command(tok.name, mode, out);
    }
  }

  /** One argument: a braced group, or the single token that follows. */
  private argument(mode: Mode): TexNode[] {
    while (this.peek()?.t === "space") this.pos += 1;
    const next = this.peek();
    if (next === undefined) return [];
    this.pos += 1;
    if (next.t === "open") return this.group(mode);
    if (next.t === "close") return [];
    const out: TexNode[] = [];
    this.token(next, mode, out);
    return out;
  }

  private script(out: TexNode[], which: "sub" | "sup", arg: TexNode[]): void {
    const last = out.pop();
    if (last?.kind === "script" && last[which] === null) {
      last[which] = arg;
      out.push(last);
      return;
    }
    out.push({ kind: "script", base: last ? [last] : [], sub: which === "sub" ? arg : null, sup: which === "sup" ? arg : null });
  }

  private command(name: string, mode: Mode, out: TexNode[]): void {
    if (name in ESCAPES) return pushText(out, ESCAPES[name]!, false);
    if (name in SPACES) return pushText(out, SPACES[name]!, false);
    if (name === "quad" || name === "qquad") {
      if (this.depth === 0) out.push({ kind: "break" });
      else pushText(out, "  ", false);
      return;
    }
    if (IGNORED.has(name)) return;
    if (name in SYMBOLS) return pushText(out, SYMBOLS[name]!, false);
    if (name in LARGE_OPERATORS) {
      out.push({ kind: "op", text: LARGE_OPERATORS[name]! });
      return;
    }
    if (OPERATORS.has(name)) {
      pushText(out, name, false);
      // \arg\max reads "arg max": a named operator keeps a space before a following word.
      const next = this.peek();
      if ((next?.t === "char" && /[A-Za-z0-9]/.test(next.ch)) || (next?.t === "cmd" && OPERATORS.has(next.name))) pushText(out, " ", false);
      return;
    }
    switch (name) {
      case "frac":
      case "dfrac":
      case "tfrac": {
        const num = this.argument("math");
        const den = this.argument("math");
        out.push({ kind: "frac", num, den, small: name === "tfrac" });
        return;
      }
      case "sqrt":
        out.push({ kind: "sqrt", body: this.argument("math") });
        return;
      case "mathrm":
      case "operatorname":
      case "mathbf":
        out.push({ kind: "group", body: this.argument("upright") });
        return;
      case "text":
      case "textrm":
      case "mbox":
        out.push({ kind: "group", body: this.argument("text") });
        return;
    }
    if (name in ACCENTS) {
      out.push({ kind: "accent", mark: ACCENTS[name]!, body: this.argument(mode === "text" ? "math" : mode) });
      return;
    }
    // Unknown: printed as written, so the page shows it and the tests catch it.
    pushText(out, `\\${name}`, false);
  }
}

/** The formula as a tree. */
export function parseTex(source: string): TexNode[] {
  return new Parser(tokenize(source)).parse();
}

/** Top-level clauses, split at \quad, each trimmed. */
export function texClauses(nodes: readonly TexNode[]): TexNode[][] {
  const clauses: TexNode[][] = [[]];
  for (const node of nodes) {
    if (node.kind === "break") clauses.push([]);
    else clauses.at(-1)!.push(node);
  }
  return clauses.map(trimClause).filter((c) => c.length > 0);
}

function trimClause(nodes: TexNode[]): TexNode[] {
  const out = nodes.map((n) => (n.kind === "text" ? { ...n } : n));
  const first = out[0];
  if (first?.kind === "text") first.text = first.text.replace(/^\s+/, "");
  // The comma or semicolon before a \quad separates clauses; once they wrap apart, the gap does that.
  const last = out.at(-1);
  if (last?.kind === "text") last.text = last.text.replace(/[\s,;]+$/, "");
  return out.filter((n) => !(n.kind === "text" && n.text === ""));
}

// Plain text ---------------------------------------------------------------------------------------------

function plain(nodes: readonly TexNode[]): string {
  return nodes.map(plainNode).join("");
}

/** A part that is more than one symbol is parenthesised in the linear reading. */
function wrapped(nodes: readonly TexNode[]): string {
  const text = plain(nodes).trim();
  return /^[\p{L}\p{M}\p{N}.′*]+$/u.test(text) || /^\(.*\)$/.test(text) ? text : `(${text})`;
}

function plainNode(node: TexNode): string {
  switch (node.kind) {
    case "text":
    case "op":
      return node.text;
    case "group":
      return plain(node.body);
    case "frac":
      return `${wrapped(node.num)}/${wrapped(node.den)}`;
    case "sqrt":
      return `√${wrapped(node.body)}`;
    case "accent": {
      const body = plain(node.body);
      return body.length === 1 ? `${body}${COMBINING[node.mark]}` : `${node.mark}(${body})`;
    }
    case "script":
      return `${plain(node.base)}${node.sub ? `_${wrapped(node.sub)}` : ""}${node.sup ? `^${wrapped(node.sup)}` : ""}`;
    case "break":
      return "; ";
  }
}

/** The formula as one line of plain text, e.g. "pct_i = 1 − (r_i − 1)/(n − 1); r_i = …". */
export function texToText(source: string): string {
  return texClauses(parseTex(source))
    .map((clause) => plain(clause).replace(/\s+/g, " ").trim())
    .join("; ");
}

// HTML ---------------------------------------------------------------------------------------------------

function renderNodes(nodes: readonly TexNode[]): ReactNode {
  return nodes.map((node, i) => <Fragment key={i}>{renderNode(node)}</Fragment>);
}

function renderNode(node: TexNode): ReactNode {
  switch (node.kind) {
    case "text":
      return node.italic ? <i>{node.text}</i> : node.text;
    case "op":
      return <span className="text-[1.2em] leading-none">{node.text}</span>;
    case "group":
      return renderNodes(node.body);
    case "frac":
      return (
        <span className={cx("mx-[0.12em] inline-flex flex-col items-center align-middle leading-[1.25]", node.small ? "text-[0.72em]" : "text-[0.86em]")}>
          <span className="px-[0.15em]">{renderNodes(node.num)}</span>
          <span className="self-stretch border-t border-current px-[0.15em] text-center">{renderNodes(node.den)}</span>
        </span>
      );
    case "sqrt":
      return (
        <span className="whitespace-nowrap">
          √<span className="border-t border-current">{renderNodes(node.body)}</span>
        </span>
      );
    case "accent": {
      const only = node.body.length === 1 ? node.body[0] : undefined;
      if (only?.kind === "text" && only.text.length === 1) {
        const marked = `${only.text}${COMBINING[node.mark]}`;
        return only.italic ? <i>{marked}</i> : marked;
      }
      return <span className="overline">{renderNodes(node.body)}</span>;
    }
    case "script":
      if (node.sub && node.sup) {
        return (
          <>
            {renderNodes(node.base)}
            <span className="inline-flex flex-col align-[-0.45em] text-[0.7em] leading-[1.15]">
              <span>{renderNodes(node.sup)}</span>
              <span>{renderNodes(node.sub)}</span>
            </span>
          </>
        );
      }
      return (
        <>
          {renderNodes(node.base)}
          {node.sub ? <sub>{renderNodes(node.sub)}</sub> : null}
          {node.sup ? <sup>{renderNodes(node.sup)}</sup> : null}
        </>
      );
    case "break":
      return null;
  }
}

export interface TexFormulaProps {
  /** TeX source, as FORMULAS holds it. */
  tex: string;
  className?: string;
}

/**
 * A formula set in the body face: clauses separated by \quad wrap as units. Screen readers get the plain
 * text reading instead of the drawn fractions and scripts.
 */
export function TexFormula({ tex, className }: TexFormulaProps) {
  const clauses = texClauses(parseTex(tex));
  return (
    <span className={cx("block font-sans text-[16px] leading-[30px] text-ink", className)}>
      <span className="sr-only">{texToText(tex)}</span>
      <span aria-hidden="true" className="flex flex-wrap items-baseline gap-x-7">
        {clauses.map((clause, i) => (
          <span key={i} className="min-w-0">
            {renderNodes(clause)}
          </span>
        ))}
      </span>
    </span>
  );
}
