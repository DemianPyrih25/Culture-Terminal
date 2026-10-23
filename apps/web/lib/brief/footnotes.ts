import { tokenizeProse, type DatasetId, type EvidenceId, type MetricId, type ProseSegment } from "@ct/contracts";
import { capitalize, formatTrendWindow, plural, TOOL_LABEL } from "./format";
import { buildLedger, metricView, requestHead, requestsForEvidence, requestTrace, shortRequestTrace, type Ledger } from "./ledger";
import type { CiteSection, Footnote, FigureLegend, Inline, MetricView } from "./types";

/**
 * The footnote registry (D6, D36): every cited number gets a superscript that resolves to its metric,
 * its evidence and the Qloo requests behind it. A metric, an evidence bundle or a figure keeps one
 * number however often it is cited. Numbers are handed out on first citation, so a builder that
 * cites in reading order numbers in reading order; `preassign` fixes an order up front instead (live
 * briefs number in arrival order).
 *
 * Each footnote comes in two forms: the long one (every detail, for the request inspector and the
 * printed endnotes) and the short one the margin prints (two lines at 1440, see ShortNote).
 */

type Kind = Footnote["kind"];

interface Entry {
  n: number;
  kind: Kind;
  key: string;
  section: CiteSection;
}

export interface FigureNoteContext {
  title: string;
  evidenceIds: readonly EvidenceId[];
  legend: FigureLegend | null;
}

const stripStop = (s: string) => s.trim().replace(/[.\s]+$/, "");

/** The longest short note: two lines of the margin at 1440. A longer note leaves parts out; it is never cut. */
export const SHORT_NOTE_MAX = 84;

/** The first candidate that fits SHORT_NOTE_MAX, most detailed first (nulls skipped); the last one when none does. */
function firstThatFits(...candidates: (string | null)[]): string {
  const options = candidates.filter((c): c is string => c !== null);
  return options.find((c) => c.length <= SHORT_NOTE_MAX) ?? options.at(-1) ?? "";
}

/** "Distinctiveness vs peers", "Momentum, Apr–Sep 2025 only": a metric's short label with what it is measured against. */
function shortWhat(view: MetricView): string {
  return `${view.shortLabel}${view.comparatorLabel ? ` ${view.comparatorLabel}` : ""}${view.window ? `, ${view.window} only` : ""}`;
}

export class FootnoteRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly figures = new Map<string, FigureNoteContext>();
  private next = 1;

  constructor(readonly ledger: Ledger) {}

  /** Reserves numbers in this order before anything is cited. */
  preassign(items: readonly { kind: Kind; key: string; section: CiteSection }[]): void {
    for (const item of items) this.assign(item.kind, item.key, item.section);
  }

  private assign(kind: Kind, key: string, section: CiteSection): number {
    const id = `${kind} ${key}`;
    const existing = this.entries.get(id);
    if (existing) return existing.n;
    const entry: Entry = { n: this.next++, kind, key, section };
    this.entries.set(id, entry);
    return entry.n;
  }

  metric(id: MetricId, section: CiteSection): number {
    return this.assign("metric", id, section);
  }

  evidence(id: EvidenceId, section: CiteSection): number {
    return this.assign("evidence", id, section);
  }

  /** A figure's own footnote: its requests, and the codes its plot uses. */
  figure(id: DatasetId, section: CiteSection, context: FigureNoteContext): number {
    this.figures.set(id, context);
    return this.assign("figure", id, section);
  }

  /** Report prose as inline pieces, citing every number in it. */
  prose(text: string, section: CiteSection): Inline[] {
    const out: Inline[] = [];
    const segments = tokenizeProse(text);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as ProseSegment;
      switch (segment.kind) {
        case "text":
          out.push({ kind: "text", text: segment.text });
          break;
        case "window":
          out.push({ kind: "window", text: this.ledger.window ? formatTrendWindow(this.ledger.window) : "the trending window" });
          break;
        case "evidence": {
          // A superscript sits on the word before it: "rows [E4]." prints "rows⁹.", not "rows ⁹.".
          const before = out.at(-1);
          if (before?.kind === "text") {
            before.text = before.text.trimEnd();
            if (before.text === "") out.pop();
          }
          out.push({ kind: "cite", evidenceId: segment.id, footnote: this.evidence(segment.id, section) });
          break;
        }
        case "metric": {
          const metric = this.ledger.state.metrics[segment.id];
          if (!metric) {
            out.push({ kind: "missing", id: segment.id, text: "not available" });
            break;
          }
          out.push({ kind: "metric", metric: metricView(metric, this.ledger.window), footnote: this.metric(segment.id, section) });
          // "{{M5}} [E5]": the citation is the metric's own evidence, so it folds into the metric's note.
          const gap = segments[i + 1];
          const next = gap?.kind === "text" && gap.text.trim() === "" ? segments[i + 2] : gap;
          if (next?.kind === "evidence" && metric.evidenceIds.includes(next.id)) i += next === gap ? 1 : 2;
          break;
        }
      }
    }
    return out;
  }

  /** Every footnote, by number, resolved through the ledger. */
  list(): Footnote[] {
    return [...this.entries.values()].sort((a, b) => a.n - b.n).map((e) => this.resolve(e));
  }

  private resolve(entry: Entry): Footnote {
    const { ledger } = this;
    const base = { n: entry.n, key: entry.key, kind: entry.kind, firstCitedIn: entry.section };
    switch (entry.kind) {
      case "metric": {
        const metric = ledger.state.metrics[entry.key as MetricId];
        if (!metric) {
          const text = `${entry.key} was not streamed.`;
          return { ...base, text, trace: "no request", short: { text, trace: "no request" }, metric: null, evidenceIds: [], requests: [], computed: null, unavailable: null };
        }
        const view = metricView(metric, ledger.window);
        const requests = requestsForEvidence(ledger, metric.evidenceIds);
        const head = requestHead(ledger, requests, metric.subjectRefs);
        const shortHead = requestHead(ledger, requests, metric.subjectRefs, { names: false });
        const what = `${view.label}${view.comparatorLabel ? `, ${view.comparatorLabel}` : ""}${view.window ? `, ${view.window} only` : ""}`;
        const brief = shortWhat(view);
        if (view.unavailable) {
          const text = [`${view.label}: not measured, ${view.reasonLabel}.`, head ? `${head}.` : null].filter(Boolean).join(" ");
          return {
            ...base,
            text,
            trace: requestTrace(requests),
            short: { text: firstThatFits(`${view.shortLabel}: not measured, ${view.reasonLabel}.`, `${view.shortLabel}: not measured.`), trace: shortRequestTrace(requests) },
            metric: view,
            evidenceIds: metric.evidenceIds,
            requests,
            computed: null,
            unavailable: { reason: metric.reason, label: view.reasonLabel ?? "not measured" },
          };
        }
        if (view.derived) {
          const from = requests.length > 0 ? ` from ${plural(requests.length, "request")}` : "";
          const label = "computed in code · QUANT";
          return {
            ...base,
            text: [head ? `${head}.` : null, `${what}, computed in QUANT${from}.`].filter(Boolean).join(" "),
            trace: `${label} · ${metric.formulaId}`,
            short: {
              text: requests.length > 0 ? firstThatFits(`${brief}, from ${plural(requests.length, "Qloo request")}.`, `${brief}.`) : `${brief}.`,
              trace: label,
            },
            metric: view,
            evidenceIds: metric.evidenceIds,
            requests,
            computed: { formulaId: metric.formulaId, label },
            unavailable: null,
          };
        }
        return {
          ...base,
          text: [head ? `${head}.` : null, `${what}.`].filter(Boolean).join(" "),
          trace: requestTrace(requests),
          // A historical number keeps its window when its label does not fit.
          short: {
            text: shortHead ? firstThatFits(`${shortHead}. ${brief}.`, view.window ? `${shortHead}. ${view.window} only.` : null, `${shortHead}.`) : `${brief}.`,
            trace: shortRequestTrace(requests),
          },
          metric: view,
          evidenceIds: metric.evidenceIds,
          requests,
          computed: null,
          unavailable: null,
        };
      }
      case "evidence": {
        const id = entry.key as EvidenceId;
        const evidence = ledger.state.evidence[id];
        const requests = requestsForEvidence(ledger, [id]);
        const head = requestHead(ledger, requests);
        const shortHead = requestHead(ledger, requests, undefined, { names: false });
        const about = evidence ? [stripStop(evidence.purpose), stripStop(evidence.summary)].filter(Boolean).join(". ") : `${id} was not streamed`;
        // The margin keeps the bundle's purpose when it fits, else names the skill ("Substitution map").
        const purpose = evidence ? capitalize(stripStop(evidence.purpose)) : null;
        const skill = evidence ? TOOL_LABEL[evidence.skill] : null;
        const lead = shortHead ? `${shortHead}. ` : "";
        const short = !evidence
          ? `${id} was not streamed.`
          : firstThatFits(purpose ? `${lead}${purpose}.` : null, skill ? `${lead}${skill}.` : null, shortHead ? `${shortHead}.` : null);
        return {
          ...base,
          text: [head ? `${head}.` : null, `${about}.`].filter(Boolean).join(" "),
          trace: requestTrace(requests),
          short: { text: short, trace: shortRequestTrace(requests) },
          metric: null,
          evidenceIds: evidence ? [id] : [],
          requests,
          computed: null,
          unavailable: null,
        };
      }
      case "figure": {
        const context = this.figures.get(entry.key);
        const evidenceIds = [...(context?.evidenceIds ?? [])];
        const requests = requestsForEvidence(ledger, evidenceIds);
        const head = requestHead(ledger, requests);
        const shortHead = requestHead(ledger, requests, undefined, { names: false });
        const about = [head ? `${head}.` : null, context ? `${stripStop(context.title)}, computed in code.` : null].filter(Boolean).join(" ");
        const legend = context?.legend ?? null;
        // A figure's codes stay whole in the margin (they are the key to its plot); otherwise its requests.
        const fallback = shortHead ? `${shortHead}.` : context ? `${stripStop(context.title)}.` : `${entry.key}.`;
        return {
          ...base,
          text: figureNoteText(legend, about || `${entry.key}.`),
          trace: requestTrace(requests),
          short: { text: figureNoteText(legend, fallback), trace: shortRequestTrace(requests) },
          metric: null,
          evidenceIds,
          requests,
          computed: null,
          unavailable: null,
        };
      }
    }
  }
}

/**
 * A figure's sidenote: the short codes its plot uses ("JC Juniper Cola · KT Kestrel Tonic."), or
 * `fallback` (its requests and title) when the legend has none. A page that fetches a dataset the
 * stream did not carry inline calls it again with `figureLegend(fetched)` and the footnote's text.
 */
export function figureNoteText(legend: FigureLegend | null, fallback: string): string {
  const codes = legend?.codes ?? [];
  return codes.length > 0 ? `${codes.map((c) => `${c.code} ${c.label}`).join(" · ")}.` : fallback;
}

/** Plain text for inline pieces: numbers print their text, footnotes as "[n]" when asked. Used for labels and tests. */
export function inlineText(inlines: readonly Inline[] | null, options: { footnotes?: boolean } = {}): string {
  if (!inlines) return "";
  return inlines
    .map((piece) => {
      switch (piece.kind) {
        case "text":
        case "window":
        case "missing":
          return piece.text;
        case "metric":
          return options.footnotes ? `${piece.metric.text}[${piece.footnote}]` : piece.metric.text;
        case "cite":
          return options.footnotes ? `[${piece.footnote}]` : "";
      }
    })
    .join("");
}

/** A registry over a fresh ledger, for callers that render prose outside a whole brief. */
export function createFootnoteRegistry(state: Ledger["state"]): FootnoteRegistry {
  return new FootnoteRegistry(buildLedger(state));
}
