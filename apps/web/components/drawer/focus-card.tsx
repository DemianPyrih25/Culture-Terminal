import type { ReactNode } from "react";
import type { Footnote } from "../../lib/brief";
import { ButtonLink } from "../ui";

/**
 * C/FocusCard: the number the drawer is about. "This number", the value, what it is, then where it came
 * from, what it means and how many lookups built it, and the link to how it is calculated.
 */

/** Answer-layer words for a number, when the page has them ("0.84 match", the chart caption). */
export interface NumberCopy {
  value?: string;
  description?: string;
  means?: string;
}

export interface FocusView {
  kicker: string;
  value: string | null;
  description: string;
  rows: { key: string; value: string }[];
  methodHref: string | null;
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const SOURCE_WORDS = { qloo: "Qloo", sec: "SEC EDGAR filings", census: "US Census estimates" } as const;
const LOOKUP_WORDS = { qloo: "Qloo", sec: "SEC EDGAR", census: "US Census" } as const;

/** "Qloo", "SEC EDGAR filings", "Qloo and US Census estimates": the sources behind a note's lookups. */
function sourcesOf(note: Footnote): (keyof typeof SOURCE_WORDS)[] {
  const found = new Set(note.requests.map((r) => r.source ?? "qloo"));
  const order = (["qloo", "sec", "census"] as const).filter((k) => found.has(k));
  return order.length > 0 ? order : ["qloo"];
}

const andList = (items: readonly string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? ""));

/** The focus card's content for a footnote, with the page's own words where it has them. */
export function focusView(note: Footnote, copy: NumberCopy | null = null, figureTitle: string | null = null): FocusView {
  const m = note.metric;
  const lookups = note.requests.length;
  const rows: { key: string; value: string }[] = [];
  const sources = sourcesOf(note);
  const from = andList(sources.map((k) => SOURCE_WORDS[k]));
  rows.push({ key: "Source", value: note.computed || m?.derived ? `Computed from ${from}${sources.length === 1 && sources[0] === "qloo" ? " data" : ""}` : `From ${from}` });
  if (m?.period) rows.push({ key: "Period", value: m.period });
  const means = copy?.means ?? (m?.unavailable ? `Not measured: ${m.reasonLabel ?? "no value"}` : m?.window ? `From ${m.window} only` : null);
  if (means) rows.push({ key: "Means", value: means });
  const lookupSource = sources.length === 1 ? `${LOOKUP_WORDS[sources[0] ?? "qloo"]} ` : "";
  rows.push({ key: "Built from", value: lookups === 0 ? "Our own code" : `${lookups} ${lookupSource}${lookups === 1 ? "lookup" : "lookups"}` });
  const formula = note.computed?.formulaId ?? m?.formulaId ?? null;
  const methodHref = formula ? `/method#${encodeURIComponent(formula)}` : null;
  if (note.kind === "figure") {
    return { kicker: "This chart", value: null, description: copy?.description ?? figureTitle ?? "A chart in this answer", rows, methodHref };
  }
  if (m) {
    const value = copy?.value ?? (m.unavailable ? "No data" : m.text);
    return { kicker: "This number", value, description: copy?.description ?? sentence(m.label), rows, methodHref };
  }
  return { kicker: "This note", value: null, description: copy?.description ?? sentence(note.text), rows, methodHref };
}

export function FocusCard({ view, children }: { view: FocusView; children?: ReactNode }) {
  return (
    <section aria-label={view.kicker} data-focus-card className="flex flex-col gap-3 rounded-tile bg-accent-soft p-4">
      <div className="flex flex-col gap-1">
        <p className="text-[12px] leading-4 font-semibold text-accent-ink">{view.kicker}</p>
        {view.value ? <p className="text-[32px] leading-9 font-semibold tracking-[-0.02em] text-ink tabular-nums">{view.value}</p> : null}
        <p className="type-body text-ink">{view.description}</p>
      </div>
      <dl className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-1">
        {view.rows.map((row) => (
          <div key={row.key} className="contents">
            <dt className="type-label text-ink-2">{row.key}</dt>
            <dd className="type-label text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>
      {view.methodHref ? (
        <ButtonLink href={view.methodHref} className="self-start">
          How it&apos;s calculated
        </ButtonLink>
      ) : null}
      {children}
    </section>
  );
}
