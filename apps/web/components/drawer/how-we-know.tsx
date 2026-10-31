"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { RunState } from "@ct/contracts";
import { GHOST_HONESTY_LINE, isPublicProvenanceRequest } from "@ct/contracts/values";
import type { BriefModel, Footnote } from "../../lib/brief";
import { CONFIDENCE_EXPLAINER, cx, DrawerShell, Icon, segmentedKeyMove, segmentedPanelId, segmentedTabId, useToast } from "../ui";
import type { CallQuery } from "./request-copy";
import { FocusCard, focusView, type NumberCopy } from "./focus-card";
import { ageText, freshnessCounts, refNames, sourceDescription } from "./source-copy";
import { lookupOf, SourceRow } from "./source-row";

/**
 * The How we know drawer (N06): the data and checks behind an answer, in four tabs. Summary, Numbers
 * (focused on the number that opened it, with the lookups behind it), Sources and Method. Pages open it
 * through `useHowWeKnow()`; its state is in the URL (?how=numbers&n=3), so a link opens it the same way.
 * It never opens on a draft: only a finished answer's numbers are checked.
 */

export type HowTab = "summary" | "numbers" | "sources" | "method";

export const HOW_TABS: readonly HowTab[] = ["summary", "numbers", "sources", "method"];

export interface HowOpenRequest {
  tab?: HowTab;
  /** A footnote number: Numbers, focused on it. */
  footnote?: number;
  /** A figure's dataset id: Numbers, focused on its footnote. */
  figure?: string;
}

export interface HowWeKnowApi {
  /** False on a draft (and outside a provider): opening does nothing. */
  available: boolean;
  isOpen: boolean;
  tab: HowTab;
  /** The footnote the drawer shows, while it is open: its key number shows selected. */
  focused: number | null;
  open: (request?: HowOpenRequest) => void;
  close: () => void;
}

const NOOP: HowWeKnowApi = { available: false, isOpen: false, tab: "summary", focused: null, open: () => undefined, close: () => undefined };

const HowWeKnowContext = createContext<HowWeKnowApi>(NOOP);

/** The drawer's controls for the answer around it. */
export function useHowWeKnow(): HowWeKnowApi {
  return useContext(HowWeKnowContext);
}

/** Reads ?how= and &n= into a request; null when the URL asks for nothing. */
export function readHowParams(search: string): HowOpenRequest | null {
  const params = new URLSearchParams(search);
  const how = params.get("how");
  if (!how || !(HOW_TABS as readonly string[]).includes(how)) return null;
  const n = Number(params.get("n"));
  return { tab: how as HowTab, ...(Number.isInteger(n) && n > 0 ? { footnote: n } : {}) };
}

/** The search string with the drawer's state written in (or taken out when `state` is null). */
export function writeHowParams(search: string, state: { tab: HowTab; footnote: number | null } | null): string {
  const params = new URLSearchParams(search);
  params.delete("how");
  params.delete("n");
  if (state) {
    params.set("how", state.tab);
    if (state.tab === "numbers" && state.footnote !== null) params.set("n", String(state.footnote));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * Each call's full query, from the provenance of the evidence bundle that used it (D30). An SEC, Census or
 * OpenStreetMap call also keeps its host (and an OpenStreetMap call its Overpass query), so the inspector
 * can show its public URL or its query.
 */
export function callQueries(evidence: RunState["evidence"] | undefined): Map<string, CallQuery> {
  const out = new Map<string, CallQuery>();
  for (const e of Object.values(evidence ?? {})) {
    e.qlooCallIds.forEach((id, i) => {
      const request = e.provenance.requests[i];
      if (!request || out.has(id)) return;
      out.set(
        id,
        isPublicProvenanceRequest(request)
          ? { path: request.path, query: request.query, host: request.host, method: request.method, ...(request.body ? { body: request.body } : {}) }
          : { path: request.path, query: request.query },
      );
    });
  }
  return out;
}

export interface HowWeKnowProviderProps {
  model: BriefModel;
  /** The run's evidence bundles, for exact request copies and public links. */
  evidence?: RunState["evidence"];
  /** The run has a GHOST answer: the Summary says how it was made. */
  ghost?: boolean;
  /** The answer page's words for a number (its key-number value, its chart caption). */
  describe?: (note: Footnote) => NumberCopy | null;
  /** Keep the drawer's state in the URL (default true). */
  syncUrl?: boolean;
  children: ReactNode;
}

interface Shown {
  tab: HowTab;
  footnote: number | null;
}

export function HowWeKnowProvider({ model, evidence, ghost = false, describe, syncUrl = true, children }: HowWeKnowProviderProps) {
  const available = model.mode === "final";
  const [shown, setShown] = useState<Shown | null>(null);
  const figureNotes = useMemo(() => new Map(model.evidence.figures.map((f) => [String(f.datasetId), f.footnote])), [model.evidence.figures]);

  const show = useCallback(
    (next: Shown | null) => {
      setShown(next);
      if (!syncUrl || typeof window === "undefined") return;
      const search = writeHowParams(window.location.search, next);
      if (search !== window.location.search) window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
    },
    [syncUrl],
  );

  const open = useCallback(
    (request: HowOpenRequest = {}) => {
      if (!available) return;
      const footnote = request.footnote ?? (request.figure ? (figureNotes.get(request.figure) ?? null) : null);
      const tab = request.tab ?? (footnote !== null ? "numbers" : "summary");
      show({ tab, footnote: tab === "numbers" ? footnote : null });
    },
    [available, figureNotes, show],
  );
  const close = useCallback(() => show(null), [show]);

  // A link with ?how= opens the drawer once the page is in the browser.
  useEffect(() => {
    if (!available || !syncUrl) return;
    const asked = readHowParams(window.location.search);
    if (!asked) return;
    const timer = setTimeout(() => setShown({ tab: asked.tab ?? "summary", footnote: asked.footnote ?? null }), 0);
    return () => clearTimeout(timer);
  }, [available, syncUrl]);

  const api = useMemo<HowWeKnowApi>(
    () => ({ available, isOpen: shown !== null, tab: shown?.tab ?? "summary", focused: shown?.footnote ?? null, open, close }),
    [available, shown, open, close],
  );

  return (
    <HowWeKnowContext value={api}>
      {children}
      {available ? (
        <HowWeKnowDrawer
          model={model}
          shown={shown}
          onTab={(tab) => show({ tab, footnote: tab === "numbers" ? (shown?.footnote ?? null) : null })}
          onFocus={(footnote) => show({ tab: "numbers", footnote })}
          onClose={close}
          queries={callQueries(evidence)}
          ghost={ghost}
          describe={describe}
        />
      ) : null}
    </HowWeKnowContext>
  );
}

/** The Numbers tab's count: the numbers the check traced, else the numbers cited. */
export function numbersCount(model: BriefModel): number {
  return model.method.checker.total ?? model.footnotes.filter((f) => f.kind === "metric").length;
}

const ID = "how-we-know";

function HowWeKnowDrawer({
  model,
  shown,
  onTab,
  onFocus,
  onClose,
  queries,
  ghost,
  describe,
}: {
  model: BriefModel;
  shown: Shown | null;
  onTab: (tab: HowTab) => void;
  onFocus: (footnote: number | null) => void;
  onClose: () => void;
  queries: ReadonlyMap<string, CallQuery>;
  ghost: boolean;
  describe?: (note: Footnote) => NumberCopy | null;
}) {
  const { show: toast, toast: toastRegion } = useToast();
  const tab = shown?.tab ?? "summary";
  const options: DrawerTab[] = [
    { value: "summary", label: "Summary", count: null },
    { value: "numbers", label: "Numbers", count: numbersCount(model) },
    { value: "sources", label: "Sources", count: model.sources.items.length },
    { value: "method", label: "Method", count: null },
  ];
  return (
    <>
      <DrawerShell
        open={shown !== null}
        onClose={onClose}
        title={<span className="block font-display text-[30px] leading-[36px] font-medium tracking-[-0.01em] text-ink max-md:text-[26px] max-md:leading-8">How we know</span>}
        subtitle={<span className="text-[13px] leading-5 font-normal text-ink-2">The data and checks behind this answer.</span>}
        toolbar={<DrawerTabs options={options} value={tab} onChange={onTab} />}
        width={540}
        className="md:border-ink"
      >
        <div className="flex min-h-full flex-col">
          <div className="flex-1">
            <HowWeKnowPanel model={model} tab={tab} footnote={shown?.footnote ?? null} onFocus={onFocus} queries={queries} onCopied={toast} ghost={ghost} describe={describe} />
          </div>
          <DrawerFoot />
        </div>
      </DrawerShell>
      {toastRegion}
    </>
  );
}

interface DrawerTab {
  value: HowTab;
  label: string;
  count: number | null;
}

/**
 * The drawer's tabs (N79MEm): plain labels on the head's bottom rule, the active one in ink with a 2 px
 * ledger-blue underline, counts in mono. One tab stop; arrow keys wrap, Home and End jump. The count
 * keeps its brackets for screen readers ("Sources (21)").
 */
function DrawerTabs({ options, value, onChange }: { options: readonly DrawerTab[]; value: HowTab; onChange: (tab: HowTab) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = segmentedKeyMove(event.key, selected, options.length);
    if (next === null) return;
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  }
  return (
    <div role="tablist" aria-label="How we know" onKeyDown={onKeyDown} className="-mb-4 flex gap-[22px] overflow-x-auto pt-1 max-md:gap-4">
      {options.map((option, index) => {
        const on = index === selected;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={segmentedTabId(ID, option.value)}
            aria-controls={segmentedPanelId(ID, option.value)}
            aria-selected={on}
            aria-label={option.count !== null ? `${option.label} (${option.count})` : undefined}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cx(
              "flex shrink-0 items-center gap-1.5 border-b-2 pb-2.5 text-[13px] leading-5 whitespace-nowrap transition-colors focus-visible:outline-offset-2",
              on ? "border-accent font-semibold text-ink" : "border-transparent font-medium text-ink-2 hover:text-ink",
            )}
          >
            {option.label}
            {option.count !== null ? (
              <span className="font-mono text-[11px] leading-4 font-normal text-ink-3 tabular-nums">
                <span className="sr-only"> (</span>
                {option.count}
                <span className="sr-only">)</span>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** The drawer's foot (N79MEm): a quiet band under the scrolling body, sticky at its bottom. */
function DrawerFoot() {
  return (
    <div className="sticky bottom-0 z-10 -mx-6 mt-8 -mb-6 flex items-center gap-2.5 border-t border-line bg-canvas px-6 py-3.5 max-md:-mx-4 max-md:flex-col max-md:items-start max-md:gap-1 max-md:px-4">
      <p className="min-w-0 flex-1 text-[12px] leading-[18px] text-ink-2">Numbers are computed by our code, never typed by the AI.</p>
      <a href="/method" className="inline-flex shrink-0 items-center gap-1 text-[12px] leading-[18px] font-semibold text-accent hover:text-accent-hover hover:underline hover:underline-offset-4">
        Every formula and rule
        <Icon name="arrow-up-right" size={12} />
      </a>
    </div>
  );
}

export interface HowWeKnowPanelProps {
  model: BriefModel;
  tab: HowTab;
  /** Numbers: the footnote in focus; null lists every number. */
  footnote: number | null;
  onFocus?: (footnote: number | null) => void;
  queries?: ReadonlyMap<string, CallQuery>;
  onCopied?: (message: string) => void;
  ghost?: boolean;
  describe?: (note: Footnote) => NumberCopy | null;
}

/** One tab's panel of the drawer (also drawn on its own by the dev gallery and the tests). */
export function HowWeKnowPanel({ model, tab, footnote, onFocus = () => undefined, queries = new Map(), onCopied = () => undefined, ghost = false, describe }: HowWeKnowPanelProps) {
  return (
    <div role="tabpanel" id={segmentedPanelId(ID, tab)} aria-labelledby={segmentedTabId(ID, tab)} data-how-tab={tab} className="flex flex-col gap-8">
      {tab === "summary" ? <SummaryPanel model={model} ghost={ghost} /> : null}
      {tab === "numbers" ? <NumbersPanel model={model} footnote={footnote} onFocus={onFocus} queries={queries} onCopied={onCopied} describe={describe} /> : null}
      {tab === "sources" ? <SourcesPanel model={model} queries={queries} onCopied={onCopied} /> : null}
      {tab === "method" ? <MethodPanel model={model} /> : null}
    </div>
  );
}

/** A section's label: small caps, 11 px, tracked, in ink-2 (the Ledger section label). */
const LABEL = "text-[11px] leading-4 font-semibold tracking-[0.09em] text-ink-2 uppercase";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * "All 28 numbers checked against their sources", or "26 of 28 numbers checked". The sources are Qloo
 * and, for public data, SEC EDGAR filings and US Census estimates.
 */
export function checkLine(model: BriefModel): { ok: boolean; text: string } {
  const { traced, total, state } = model.method.checker;
  if (state === "passed" && traced !== null && total !== null) {
    return traced === total ? { ok: true, text: `All ${total} numbers checked against their sources` } : { ok: false, text: `${traced} of ${total} numbers checked` };
  }
  if (state === "skipped") return { ok: false, text: "This partial answer was not checked" };
  if (traced !== null && total !== null) return { ok: false, text: `${traced} of ${total} numbers checked` };
  return { ok: false, text: "The numbers were not checked" };
}

function SummaryPanel({ model, ghost }: { model: BriefModel; ghost: boolean }) {
  const check = checkLine(model);
  const { saved, live } = freshnessCounts(model.sources.items);
  const from = providers(model);
  const conviction = model.conviction;
  return (
    <>
      <p
        className={cx(
          "flex items-start gap-2.5 rounded-sm px-3.5 py-3 text-[13px] leading-5 font-medium",
          check.ok ? "bg-good-soft text-good-ink" : "bg-caution-soft text-caution-ink",
        )}
        data-check={check.ok ? "passed" : "partial"}
      >
        <span className="flex h-5 shrink-0 items-center">
          <Icon name={check.ok ? "badge-check" : "triangle-alert"} size={16} className={check.ok ? "text-good" : "text-caution"} />
        </span>
        {check.text}.
      </p>
      <div className="-mt-3 flex flex-col gap-1">
        <p className="font-mono text-[12px] leading-[18px] text-ink-2 tabular-nums">
          {plural(numbersCount(model), "number")} · {plural(model.sources.items.length, "source")} · {plural(saved, "saved copy", "saved copies")}, {live} fetched live
        </p>
        {from ? (
          <p className="text-[12px] leading-[18px] text-ink-2" data-providers>
            {from}
          </p>
        ) : null}
      </div>
      {conviction.summary ? (
        <section aria-label="Confidence" className="flex flex-col gap-2.5">
          <p className={LABEL} aria-hidden="true">
            Confidence · signal checks
          </p>
          <div className="flex flex-col gap-2.5 rounded-sm border border-line bg-canvas px-4 py-3.5">
            <div className="flex items-center justify-between gap-3">
              <h3 className={cx("inline-flex items-center gap-1.5 rounded-xs px-2 py-0.5 text-[12px] leading-[18px] font-semibold", BAND_CHIP[conviction.summary.band] ?? BAND_CHIP.MED)}>
                <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                {conviction.summary.bandLabel} confidence
              </h3>
              <span className="font-mono text-[12px] leading-4 text-ink-2 tabular-nums">{conviction.summary.score} / 100</span>
            </div>
            <p className="text-[12px] leading-[18px] text-ink-2">{CONFIDENCE_EXPLAINER}</p>
            {conviction.why && conviction.why.lines.length > 0 ? (
              <ul className="flex flex-col">
                {conviction.why.lines.map((line) => (
                  <li key={line.rule} className="flex items-baseline justify-between gap-3 border-t border-line py-1.5 text-[13px] leading-5 text-ink-2">
                    <span>{line.label}</span>
                    <span className="shrink-0 font-mono text-[12px] font-medium text-danger tabular-nums">{line.pointsText}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="border-t border-line pt-1.5 text-[13px] leading-5 text-ink">Nothing lowered it.</p>
            )}
          </div>
        </section>
      ) : null}
      <DataSources model={model} />
      {ghost ? <p className="text-[12px] leading-[18px] text-ink-2">{GHOST_HONESTY_LINE}</p> : null}
      <NotInOurData model={model} />
    </>
  );
}

const SOURCE_ROWS = [
  { key: "qloo", name: "Qloo taste data", tag: "Measured", tone: "bg-sunken text-ink-2" },
  { key: "sec", name: "SEC EDGAR filings", tag: "Public data", tone: "bg-good-soft text-good-ink" },
  { key: "census", name: "US Census Bureau · ACS 5-year", tag: "Public data", tone: "bg-good-soft text-good-ink" },
  { key: "osm", name: "OpenStreetMap · Overpass API", tag: "Public data", tone: "bg-good-soft text-good-ink" },
] as const;

/** "Saved copies, 2–9 h old · 3 fetched live, 30 Oct 14:02": how fresh one provider's lookups are. */
export function providerFreshness(items: readonly BriefModel["sources"]["items"][number][]): string {
  const saved = items.filter((s) => s.cache !== "miss");
  const live = items.filter((s) => s.cache === "miss");
  const parts: string[] = [];
  if (saved.length > 0) {
    const ages = saved.map((s) => s.cacheAgeMs).filter((a): a is number => a !== null);
    const lo = ages.length > 0 ? ageText(Math.min(...ages)) : null;
    const hi = ages.length > 0 ? ageText(Math.max(...ages)) : null;
    const word = saved.length === 1 ? "Saved copy" : "Saved copies";
    parts.push(lo && hi ? (lo === hi ? `${word}, ${hi} old` : lo.split(" ")[1] === hi.split(" ")[1] ? `${word}, ${lo.split(" ")[0]}–${hi} old` : `${word}, ${lo} to ${hi} old`) : word);
  }
  if (live.length > 0) {
    const last = live.map((s) => s.at).sort().at(-1);
    const d = last ? new Date(last) : null;
    const pad = (n: number) => String(n).padStart(2, "0");
    const at = d && !Number.isNaN(d.getTime()) ? `${d.getUTCDate()} ${MONTH_WORDS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : null;
    const lead = saved.length > 0 ? `${live.length} fetched live` : "Fetched live";
    parts.push(at ? `${lead}, ${at}` : lead);
  }
  return parts.join(" · ");
}

const MONTH_WORDS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** What one provider's lookups fetched: "audience data, interest by area, taste tags" (first three kinds). */
function providerKinds(items: readonly BriefModel["sources"]["items"][number][]): string | null {
  const kinds = [...new Set(items.map((s) => sourceDescription(s).replace(/ for .*$/, "").replace(/ \(.*\)$/, "").replace(/ in Qloo$/, "").toLowerCase()))];
  if (kinds.length === 0) return null;
  return kinds.length > 3 ? `${kinds.slice(0, 3).join(", ")} and more` : kinds.join(", ");
}

/** Data sources and freshness (N79MEm): one row per provider the answer used, with its tag. */
function DataSources({ model }: { model: BriefModel }) {
  const rows = SOURCE_ROWS.flatMap((row) => {
    const items = model.sources.items.filter((s) => (s.source ?? "qloo") === row.key);
    return items.length > 0 ? [{ ...row, items }] : [];
  });
  if (rows.length === 0) return null;
  return (
    <section aria-label="Data sources and freshness" className="flex flex-col">
      <h3 className={cx(LABEL, "mb-2")}>Data sources and freshness</h3>
      <ul className="flex flex-col">
        {rows.map((row) => {
          const kinds = providerKinds(row.items);
          return (
            <li key={row.key} className="flex items-start gap-3 border-b border-line py-2.5" data-provider={row.key}>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13px] leading-5 font-semibold text-ink">{row.name}</span>
                <span className="text-[12px] leading-[18px] text-ink-2">
                  {plural(row.items.length, "lookup")}
                  {kinds ? ` · ${kinds}` : ""}
                </span>
                <span className="flex items-center gap-1.5 font-mono text-[10px] leading-4 text-ink-2">
                  <Icon name="clock-4" size={11} className="shrink-0 text-ink-3" />
                  {providerFreshness(row.items)}
                  {row.key === "osm" ? " · © OpenStreetMap contributors" : ""}
                </span>
              </span>
              <span className={cx("mt-0.5 shrink-0 rounded-xs px-1.5 py-0.5 text-[10px] leading-3.5 font-semibold tracking-[0.04em] uppercase", row.tone)}>{row.tag}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What is not in our data (N79MEm): what the question asked that no source covers, then the fixed limits. */
function NotInOurData({ model }: { model: BriefModel }) {
  const notCovered = model.method.interpretation?.readAs?.notCovered ?? [];
  const lines = [
    ...(notCovered.length > 0 ? [`Not covered for this question: ${notCovered.join(", ")}. We have no data on ${notCovered.length === 1 ? "it" : "them"}.`] : []),
    ...model.disclaimers,
  ];
  if (lines.length === 0) return null;
  return (
    <section aria-label="What is not in our data" className="flex flex-col gap-2">
      <h3 className={LABEL}>What is not in our data</h3>
      <ul className="flex flex-col gap-1.5">
        {lines.map((line) => (
          <li key={line} className="flex gap-2 text-[13px] leading-[19px] text-ink-2">
            <span aria-hidden="true" className="text-ink-3">
              —
            </span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The confidence band's chip colours. */
const BAND_CHIP: Readonly<Record<string, string>> = {
  HIGH: "bg-good-soft text-good-ink",
  MED: "bg-caution-soft text-caution-ink",
  LOW: "bg-danger-soft text-danger-ink",
};

const PROVIDER_NAME = { qloo: "Qloo", sec: "SEC EDGAR", census: "US Census Bureau", osm: "OpenStreetMap" } as const;

/**
 * "From Qloo (18 lookups), SEC EDGAR (2) and US Census Bureau (1)." when public data was used; null when
 * every lookup went to Qloo, which the line above already counts.
 */
export function providers(model: BriefModel): string | null {
  const counts = new Map<keyof typeof PROVIDER_NAME, number>();
  for (const s of model.sources.items) counts.set(s.source ?? "qloo", (counts.get(s.source ?? "qloo") ?? 0) + 1);
  if (![...counts.keys()].some((k) => k !== "qloo")) return null;
  const parts = (["qloo", "sec", "census", "osm"] as const).flatMap((k, i) => {
    const n = counts.get(k);
    return n ? [`${PROVIDER_NAME[k]} (${i === 0 ? plural(n, "lookup") : n})`] : [];
  });
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `From ${list}.`;
}

/** The footnotes a reader can focus on: numbers first, then charts. */
function focusable(model: BriefModel): Footnote[] {
  return model.footnotes.filter((f) => f.kind === "metric" || f.kind === "figure");
}

function NumbersPanel({
  model,
  footnote,
  onFocus,
  queries,
  onCopied,
  describe,
}: {
  model: BriefModel;
  footnote: number | null;
  onFocus: (footnote: number | null) => void;
  queries: ReadonlyMap<string, CallQuery>;
  onCopied: (message: string) => void;
  describe?: (note: Footnote) => NumberCopy | null;
}) {
  const note = footnote === null ? undefined : model.footnotes.find((f) => f.n === footnote);
  if (!note) {
    const notes = focusable(model);
    if (notes.length === 0) return <p className="type-body text-ink-2">No numbers in this answer.</p>;
    return (
      <ul className="flex flex-col border-t border-line" aria-label="Numbers in this answer">
        {notes.map((n) => {
          const view = focusView(n, describe?.(n) ?? null, model.evidence.figures.find((f) => f.footnote === n.n)?.title ?? null);
          return (
            <li key={n.n}>
              <button
                type="button"
                onClick={() => onFocus(n.n)}
                className="group flex w-full items-center gap-4 border-b border-line py-3 text-left transition-colors hover:bg-canvas"
              >
                <span className={cx("w-24 shrink-0 truncate text-ink", view.value ? "font-mono text-[15px] leading-5 font-medium tabular-nums" : "text-[13px] leading-5 font-semibold")}>
                  {view.value ?? view.kicker}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink-2">{view.description}</span>
                <Icon name="chevron-right" size={16} className="shrink-0 text-ink-3 group-hover:text-ink-2" />
              </button>
            </li>
          );
        })}
      </ul>
    );
  }
  const figureTitle = model.evidence.figures.find((f) => f.footnote === note.n)?.title ?? null;
  const lookups = note.requests.map((r) => lookupOf(r, model.sources.items)).filter((l) => l !== null);
  const names = refNames(model.sources.items);
  return (
    <>
      <button type="button" onClick={() => onFocus(null)} className="-mb-2 inline-flex items-center gap-1 self-start rounded-xs text-[12px] leading-4 font-semibold text-accent hover:text-accent-hover">
        <Icon name="chevron-left" size={14} />
        All numbers
      </button>
      <FocusCard view={focusView(note, describe?.(note) ?? null, figureTitle)} />
      {lookups.length > 0 ? (
        <section aria-labelledby={`${ID}-lookups`} className="flex flex-col gap-2">
          <h3 id={`${ID}-lookups`} className={LABEL}>
            Lookups behind this number
          </h3>
          <ul className="flex flex-col border-t border-line">
            {lookups.map((l, i) => (
              <SourceRow key={l.qlooCallId} lookup={l} query={queries.get(l.qlooCallId)} defaultOpen={i === 0} names={names} onCopied={onCopied} />
            ))}
          </ul>
        </section>
      ) : (
        <p className="type-body text-ink-2">Our own code worked this out; no single lookup stands behind it alone.</p>
      )}
    </>
  );
}

function SourcesPanel({ model, queries, onCopied }: { model: BriefModel; queries: ReadonlyMap<string, CallQuery>; onCopied: (message: string) => void }) {
  if (model.sources.items.length === 0) return <p className="type-body text-ink-2">No lookups were made.</p>;
  const names = refNames(model.sources.items);
  const { saved, live } = freshnessCounts(model.sources.items);
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-baseline gap-2 text-[12px] leading-[18px] text-ink-2">
        <span>{plural(model.sources.items.length, "lookup")}, in the order they ran</span>
        <span className="ml-auto font-mono text-[11px] text-ink-3 tabular-nums">
          {saved} saved · {live} live
        </span>
      </p>
      <ul className="flex flex-col border-t border-line" aria-label="Lookups">
        {model.sources.items.map((s) => (
          <SourceRow key={s.qlooCallId} lookup={s} query={queries.get(s.qlooCallId)} names={names} onCopied={onCopied} />
        ))}
      </ul>
    </div>
  );
}

const STEP_WORD: Readonly<Record<string, string>> = {
  planned: "Planned",
  running: "Running",
  not_run: "Not run",
  stopped: "Stopped",
  ok: "Done",
  partial: "Partly done",
  empty: "No data",
  error: "Failed",
};

const hasPublic = (model: BriefModel) => model.sources.items.some((s) => s.source === "sec" || s.source === "census" || s.source === "osm");

function checkerText(model: BriefModel): string {
  const c = model.method.checker;
  switch (c.state) {
    case "passed":
      return `Every number was traced to its lookup in Qloo${hasPublic(model) ? " or a public source (SEC EDGAR, the US Census, OpenStreetMap)" : ""}${c.adviceTerms !== null ? `, and no advice wording was found` : ""}.`;
    case "rejected":
      return "The check sent the draft back to be fixed.";
    case "skipped":
      return "This partial answer was not checked.";
    case "stopped":
      return "The run stopped before the check.";
    case "queued":
    case "checking":
      return "The check runs once the answer is written.";
  }
}

/**
 * The context receipt without money: "Context: AI · web (3 searches)". Spend shows on Settings only, never
 * on an answer.
 */
export function contextReceipt(context: string): string {
  return context
    .replace(/\s*~?\$\d[\d,]*(?:\.\d+)?/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** A step's status chip colours: done green, partly done or no data amber, failed red, the rest quiet. */
const STEP_CHIP: Readonly<Record<string, string>> = {
  ok: "bg-good-soft text-good-ink",
  partial: "bg-caution-soft text-caution-ink",
  empty: "bg-caution-soft text-caution-ink",
  error: "bg-danger-soft text-danger-ink",
};

/** A key and its value on a hairline (the Method tab's reading of the question). */
function Def({ term, children, data }: { term: string; children: ReactNode; data?: string }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 border-t border-line py-2" {...(data ? { [data]: true } : {})}>
      <dt className="text-[12px] leading-5 text-ink-2">{term}</dt>
      <dd className="text-[13px] leading-5 text-ink">{children}</dd>
    </div>
  );
}

function MethodPanel({ model }: { model: BriefModel }) {
  const { method } = model;
  const reading = method.interpretation;
  const passed = method.checker.state === "passed";
  return (
    <>
      {reading ? (
        <section aria-label="How the question was read" className="flex flex-col gap-2">
          <h3 className={LABEL}>How we read the question</h3>
          <dl className="flex flex-col">
            <Def term="Job">{reading.jobLabel}</Def>
            {reading.subjects.length > 0 ? <Def term="Subjects">{reading.subjects.join(", ")}</Def> : null}
            {reading.readAs ? (
              <Def term="Read as" data="data-read-as">
                {reading.readAs.line}
              </Def>
            ) : null}
            {reading.assumptions.length > 0 ? (
              <Def term="Assumed">
                {reading.assumptions.length === 1 ? (
                  reading.assumptions[0]
                ) : (
                  <ul className="flex list-disc flex-col gap-0.5 pl-4 marker:text-ink-3">
                    {reading.assumptions.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                )}
              </Def>
            ) : null}
          </dl>
        </section>
      ) : null}
      {method.steps.length > 0 ? (
        <section aria-label="Steps" className="flex flex-col gap-2">
          <h3 className={LABEL}>What we looked up</h3>
          <ol className="flex flex-col">
            {method.steps.map((step) => {
              const lookups = step.actual + (step.publicActual ?? 0);
              return (
                <li key={step.n} className="flex items-start gap-3 border-t border-line py-[9px] last:border-b">
                  <span className="w-4 shrink-0 font-mono text-[11px] leading-5 font-medium text-accent tabular-nums">{step.n}</span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[13px] leading-5 font-medium text-ink">{step.toolLabel}</span>
                    {step.purpose ? <span className="text-[12px] leading-[18px] text-ink-2">{step.purpose}</span> : null}
                  </span>
                  <span className={cx("mt-px shrink-0 rounded-xs px-[7px] py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap", STEP_CHIP[step.status] ?? "bg-sunken text-ink-2")}>
                    {STEP_WORD[step.status] ?? step.status}
                    {lookups > 0 ? ` · ${plural(lookups, "lookup")}` : ""}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
      {method.pivots.length > 0 || method.fallbacks.length > 0 ? (
        <section aria-label="Changes of plan" className="flex flex-col gap-2">
          <h3 className={LABEL}>Where the plan changed</h3>
          <ul className="flex flex-col gap-2 text-[13px] leading-5 text-ink-2">
            {method.pivots.map((p) => (
              <li key={p.toolCallId} className="flex gap-2">
                <Icon name="corner-down-right" size={14} className="mt-[3px] shrink-0 text-ink-3" />
                <span>
                  Looked closer with {p.toolLabel.toLowerCase()}
                  {p.finding ? ` after noticing: ${p.finding.replace(/[.\s]+$/, "")}.` : "."}
                </span>
              </li>
            ))}
            {method.fallbacks.map((f, i) => (
              <li key={i} className="flex gap-2">
                <Icon name="corner-down-right" size={14} className="mt-[3px] shrink-0 text-ink-3" />
                <span>
                  Our code switched from {f.from} to {f.to}: {f.reason.replace(/[.\s]+$/, "")}.
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label="The check" className="flex flex-col gap-2">
        <h3 className={LABEL}>The check</h3>
        <p className={cx("flex items-start gap-2.5 rounded-sm px-3 py-2.5 text-[13px] leading-5 text-ink", passed ? "bg-good-soft" : "bg-caution-soft")}>
          <Icon name={passed ? "circle-check" : "triangle-alert"} size={16} className={cx("mt-0.5 shrink-0", passed ? "text-good" : "text-caution")} />
          <span>{checkerText(model)}</span>
        </p>
      </section>
      {method.context ? (
        <section aria-label="Context receipt" className="flex flex-col gap-2">
          <h3 className={LABEL}>Context receipt</h3>
          <p className="text-[13px] leading-5 text-ink-2" data-context-receipt="true">
            {contextReceipt(method.context)}. The AI and web blocks are shown apart and never change the measured answer.
          </p>
        </section>
      ) : null}
    </>
  );
}
