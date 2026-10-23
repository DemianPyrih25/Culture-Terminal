"use client";

import type { Pillar } from "@ct/contracts";
import Link from "next/link";
import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { GRID_COLUMNS_MD, GRID_COLUMNS_XL, SCROLL_ANCHOR_CLASS } from "../layout/grid";
import { Outline } from "../layout/outline";
import { Button, ButtonLink } from "../ui/button";
import { cx } from "../ui/cx";
import { ArrowRightIcon, CheckIcon } from "../ui/icons";
import { Keycap } from "../ui/keycap";
import { MetaLine } from "../ui/meta-line";
import { Search } from "../ui/search";
import { SortToggle } from "../ui/sort-toggle";
import { BADGE_LABEL, DESK_LABEL } from "../../lib/brief/format";
import type { Badge } from "@ct/contracts";
import { BriefListHeader, BriefRowView } from "./brief-rows";
import type { BriefList, BriefSort, BriefSummary } from "./briefs-client";
import { DESK_ORDER, deskJobText, headlinePieces, type HeadlineNote } from "./format";
import { isGrouped, libraryHref, type LibraryParams } from "./library-params";

/** The counts every list answer carries, for the head, the outline and the margin. */
export type LibrarySummary = Pick<BriefList, "total" | "pillars" | "numbersTraced" | "pillarsTraced">;

/** What the library shows. */
export type LibraryData =
  | { kind: "loading" }
  | { kind: "error"; message: string; retry: boolean }
  /** Every desk: the latest few of each (no desk, no search). */
  | { kind: "grouped"; groups: Record<Pillar, BriefSummary[]>; summary: LibrarySummary; year: number }
  /** One desk, or a search: one list, paged with Load more. */
  | {
      kind: "flat";
      runs: BriefSummary[];
      next: string | null;
      summary: LibrarySummary;
      year: number;
      loadingMore: boolean;
      moreError: string | null;
    };

/** Briefs shown per desk on the grouped view. */
export const LATEST_PER_DESK = 2;

const SORT_OPTIONS = [
  { value: "date", label: "Date" },
  { value: "conviction", label: "Conviction" },
] as const;

export interface LibraryBodyProps {
  params: LibraryParams;
  /** The search field's text (it runs a little behind the typing). */
  search: string;
  data: LibraryData;
  /** The selected brief, expanded with its verdict; null for the first one shown. */
  selectedId: string | null;
  /** A fetch is under way for the current view (a new search or sort). */
  refreshing?: boolean;
  onSearch?: (value: string) => void;
  onSort?: (sort: BriefSort) => void;
  onSelect?: (runId: string) => void;
  onLoadMore?: () => void;
  onRetry?: () => void;
  onClearSearch?: () => void;
}

const ROW = "min-w-0 xl:col-span-3 xl:grid xl:grid-cols-subgrid xl:items-start";
const READING = "min-w-0 xl:col-start-1";
const MARGIN = "min-w-0 xl:col-start-3";
const DESK_PLURAL = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "brief" : "briefs"}`;

/** The runs the view lists, in order: the selection and the arrow keys walk them. */
export function listedRuns(data: LibraryData): BriefSummary[] {
  if (data.kind === "grouped") return DESK_ORDER.flatMap((p) => data.groups[p]);
  if (data.kind === "flat") return data.runs;
  return [];
}

/** The outline's footer on the grouped view: what each desk shows, by the sort. */
export function groupedMeta(sort: BriefSort): string {
  return sort === "conviction"
    ? `Top ${LATEST_PER_DESK} per desk by conviction. Open a desk for the full list.`
    : `Latest ${LATEST_PER_DESK} per desk. Open a desk for the full list.`;
}

/** ↑ ↓ move between the briefs' links; focusing one selects it. */
function moveBetweenBriefs(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const target = event.target as HTMLElement;
  if (!target.matches("[data-brief-link]")) return;
  const links = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-brief-link]")];
  const at = links.indexOf(target);
  const next = links[at + (event.key === "ArrowDown" ? 1 : -1)];
  if (at < 0 || !next) return;
  event.preventDefault();
  next.focus();
}

/** The parts of a key press the page-level arrow rule reads. */
export interface PageArrowKey {
  key: string;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/**
 * Whether a key press enters the brief list: a bare ↑ or ↓ while nothing has focus (the page itself, as
 * on arrival or after a click outside any control). Pressed on a field or a control, it is theirs.
 */
export function entersBriefList(event: PageArrowKey, focusedTag: string | null): boolean {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.isComposing || event.defaultPrevented) return false;
  const tag = focusedTag?.toUpperCase() ?? null;
  return tag === null || tag === "BODY" || tag === "HTML";
}

/**
 * ↑ ↓ from the page focus the selected brief (the first shown when none is), so the arrows the margin
 * advertises work before the reader has tabbed into the list; from there moveBetweenBriefs takes over.
 */
function useArrowsEnterList(list: RefObject<HTMLElement | null>, selected: string | null): void {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!entersBriefList(event, document.activeElement?.tagName ?? null)) return;
      const links = [...(list.current?.querySelectorAll<HTMLElement>("[data-brief-link]") ?? [])];
      const link = links.find((el) => el.dataset.briefLink === selected) ?? links[0];
      if (!link) return;
      event.preventDefault();
      link.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, selected]);
}

/** The verdict, top-aligned beside Open brief so its first line stays level with the sidenotes. */
function Headline({ brief, pieces }: { brief: BriefSummary; pieces: ReturnType<typeof headlinePieces>["pieces"] }) {
  if (brief.headline === null) {
    return (
      <p className="flex-1 font-serif text-[15px] leading-[23px] text-dim sm:self-start">
        {brief.status === "incomplete" ? "This run stopped before its note was written." : "No verdict was recorded."}
      </p>
    );
  }
  return (
    <p className="flex-1 font-serif text-[15px] leading-[23px] text-text-2 sm:self-start">
      {pieces.map((piece, i) =>
        piece.kind === "text" ? (
          <span key={i}>{piece.text}</span>
        ) : (
          <span key={i} className={piece.unavailable ? "text-dim italic" : "text-ink"}>
            {piece.text}
            <sup className="pl-px font-sans text-[10px] font-semibold text-accent">{piece.note}</sup>
          </span>
        ),
      )}
    </p>
  );
}

function Notes({ notes, className }: { notes: readonly HeadlineNote[]; className?: string }) {
  return (
    <ol aria-label="Numbers in this verdict" className={cx("flex flex-col gap-3", className)}>
      {notes.map((n) => (
        <li key={n.note} className="flex gap-2">
          <span className="w-3 shrink-0 text-[11px] leading-[17px] font-semibold text-accent">{n.note}</span>
          <span className="flex min-w-0 flex-col gap-[2px]">
            <span className="text-[12px] leading-[17px] text-dim">
              {n.label}: <span className={n.unavailable ? "italic" : "text-text-2"}>{n.value}</span>
            </span>
            <span className="font-mono text-[10.5px] leading-[15px] text-dim">{BADGE_LABEL[n.badge as Badge] ?? n.badge}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A brief of the library: the A/Brief row, expanded with its verdict and notes when selected. From
 * 1280 px the verdict is a second grid row and the notes hang in the margin beside it, level with its
 * first line however the question wraps; narrower, they sit inside the selected band, under the verdict.
 */
function LibraryRow({ brief, selected, year, onSelect }: { brief: BriefSummary; selected: boolean; year: number; onSelect?: (id: string) => void }) {
  const { pieces, notes } = selected && brief.headline !== null ? headlinePieces(brief.headline, brief.metrics) : { pieces: [], notes: [] };
  return (
    <li className={cx(ROW, "relative")} onClick={() => onSelect?.(brief.runId)}>
      {selected ? (
        // The band spans the row and its verdict in the reading column; below 1280 px it is the item's own.
        <div aria-hidden="true" className="contents xl:relative xl:col-start-1 xl:row-[1/span_2] xl:block xl:self-stretch">
          <span className="absolute inset-y-0 -left-4 -right-4 border-l-2 border-accent bg-canvas max-md:-left-2 max-md:-right-2" />
        </div>
      ) : null}
      <BriefRowView
        brief={brief}
        columns="library"
        year={year}
        meta={deskJobText(brief, false)}
        rule={!selected}
        stretched={false}
        onFocus={() => onSelect?.(brief.runId)}
        className={cx(READING, "z-[1] xl:row-start-1")}
        linkClassName="focus-visible:outline-offset-4"
      />
      {selected ? (
        <div className={cx(READING, "relative z-[1] border-b border-line xl:row-start-2")}>
          <div className="flex flex-col gap-3 pb-[14px] sm:flex-row sm:items-end sm:gap-6">
            <Headline brief={brief} pieces={pieces} />
            <ButtonLink variant="primary" size="sm" href={`/run/${brief.runId}`} tabIndex={-1}>
              Open brief
            </ButtonLink>
          </div>
          {notes.length > 0 ? (
            <div role="note" aria-label="Sidenotes" className="pb-[14px] xl:hidden">
              <Notes notes={notes} />
            </div>
          ) : null}
        </div>
      ) : null}
      {selected && notes.length > 0 ? (
        // Height 0: the notes hang beside the rows below, never pushing them down, above the pinned snapshot note.
        <div role="note" aria-label="Sidenotes" className={cx(MARGIN, "relative z-[2] xl:row-start-2 max-xl:hidden xl:h-0 xl:overflow-visible")}>
          <Notes notes={notes} className="bg-paper pt-[3px]" />
        </div>
      ) : null}
    </li>
  );
}

function GroupHead({ index, pillar, count, sort }: { index: number; pillar: Pillar; count: number; sort: BriefSort }) {
  return (
    <div
      className={cx(
        "flex items-center gap-[10px] pt-[10px] pb-1",
        index > 0 && "mt-[11px] border-t border-line-strong",
      )}
    >
      <h2 id={`desk-${pillar}`} className={cx("flex items-center gap-[10px] text-[11px] leading-4 font-semibold tracking-[1.3px] uppercase", SCROLL_ANCHOR_CLASS)}>
        <span className="text-dim">{String(index + 1).padStart(2, "0")}</span>
        <span className="text-ink">{DESK_LABEL[pillar]}</span>
      </h2>
      {count > 0 ? (
        <Link
          href={libraryHref({ q: "", sort, desk: pillar })}
          className="ml-auto inline-flex items-center gap-[6px] text-[12px] leading-4 font-medium text-accent hover:underline hover:underline-offset-4"
        >
          All {count.toLocaleString("en-US")}
          <span className="sr-only"> {DESK_LABEL[pillar]} briefs</span>
          <ArrowRightIcon size={12} />
        </Link>
      ) : null}
    </div>
  );
}

/** Every desk as a filter, the current one marked, with its count once the list has answered. */
function deskItems(params: LibraryParams, summary: LibrarySummary | null) {
  return [
    { desk: null, label: "All desks", count: summary?.total ?? null },
    ...DESK_ORDER.map((p) => ({ desk: p, label: DESK_LABEL[p], count: summary?.pillars[p] ?? null })),
  ].map((item) => ({ ...item, href: libraryHref({ ...params, desk: item.desk }), active: item.desk === params.desk }));
}

/** The outline of a flat list: every desk as a filter, the current one marked. */
function DeskNav({ params, summary }: { params: LibraryParams; summary: LibrarySummary | null }) {
  return (
    <nav aria-label="Desks" className="flex w-full flex-col">
      <p className="pb-3 pl-[14px] text-[10px] leading-3 font-semibold tracking-[1.2px] text-dim uppercase">Desks</p>
      <ul className="flex flex-col border-l border-line">
        {deskItems(params, summary).map((item) => (
          <li key={item.label}>
            <Link
              href={item.href}
              aria-current={item.active ? "page" : undefined}
              className={cx(
                "-ml-px flex h-[30px] items-center justify-between gap-3 border-l-2 pl-3 text-[13px] focus-visible:-outline-offset-2",
                item.active ? "border-accent font-medium text-ink" : "border-transparent text-dim hover:text-ink",
              )}
            >
              <span>{item.label}</span>
              {item.count !== null ? (
                <span className="pr-2 text-[12px] font-normal text-dim">{item.count}</span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
      <p className="pt-[18px] pl-[14px] text-[11px] leading-4 text-dim">
        {params.q.trim() !== "" ? "Briefs whose question matches the search." : "Every brief on this desk, 20 at a time."}
      </p>
    </nav>
  );
}

/** The desks as one wrapping row of links, on phones, where the outline column is hidden. */
function DeskRow({ params, summary }: { params: LibraryParams; summary: LibrarySummary | null }) {
  return (
    <nav aria-label="Desks" className="pb-4 md:hidden">
      <ul className="flex flex-wrap gap-x-4 gap-y-2 text-[13px]">
        {deskItems(params, summary).map((item) => (
          <li key={item.label}>
            <Link
              href={item.href}
              aria-current={item.active ? "page" : undefined}
              className={cx(
                "inline-flex h-8 items-center gap-[6px] border-b-2",
                item.active ? "border-accent font-medium text-ink" : "border-transparent text-dim hover:text-ink",
              )}
            >
              {item.label}
              {item.count !== null ? <span className="text-[12px] font-normal text-dim">{item.count}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The numbers traced of what the view lists: one desk's on a desk view, every desk's otherwise. */
export function tracedOf(summary: LibrarySummary, desk: Pillar | null): { traced: number; total: number; briefs: number } | null {
  const { traced, total } = desk ? summary.pillarsTraced[desk] : summary.numbersTraced;
  const briefs = desk ? summary.pillars[desk] : summary.total;
  return briefs === 0 || total === 0 ? null : { traced, total, briefs };
}

function TraceNote({ summary, desk }: { summary: LibrarySummary; desk: Pillar | null }) {
  const trace = tracedOf(summary, desk);
  if (trace === null) return null;
  return (
    <div className="flex flex-col gap-1 border-b border-line pb-3">
      <p className="flex items-center gap-2 text-[13px] leading-4 font-semibold text-ink">
        <CheckIcon className="text-accent" />
        {trace.traced.toLocaleString("en-US")} / {trace.total.toLocaleString("en-US")} numbers traced
      </p>
      <p className="pl-[22px] text-[11px] leading-[13px] text-dim">Across {DESK_PLURAL(trace.briefs)} · Checker</p>
    </div>
  );
}

/** The trace note in one line, under the head, where there is no margin (below 1280 px). */
function TraceLine({ summary, desk }: { summary: LibrarySummary; desk: Pillar | null }) {
  const trace = tracedOf(summary, desk);
  if (trace === null) return null;
  return (
    <p className="flex items-center gap-2 pb-3 text-[12px] text-dim xl:hidden">
      <CheckIcon className="text-accent" />
      <span>
        <span className="font-semibold text-ink">
          {trace.traced.toLocaleString("en-US")} / {trace.total.toLocaleString("en-US")} numbers traced
        </span>{" "}
        · across {DESK_PLURAL(trace.briefs)} · Checker
      </span>
    </p>
  );
}

function SnapshotNote() {
  return (
    <div className="flex flex-col gap-2 border-t border-line bg-paper pt-3">
      <p className="text-[10px] leading-3 font-semibold tracking-[1.2px] text-dim uppercase">Briefs are snapshots</p>
      <p className="text-[12px] leading-[17px] text-dim">
        Each brief keeps the data it was written with. Ask the question again to read it against today&apos;s data.
      </p>
      <p className="flex items-center gap-[14px] pt-[6px] text-[11px] text-dim max-sm:hidden" aria-hidden="true">
        <span className="flex items-center gap-[6px]">
          <Keycap>↑↓</Keycap> move
        </span>
        <span className="flex items-center gap-[6px]">
          <Keycap>↵</Keycap> open
        </span>
        <span className="flex items-center gap-[6px]">
          <Keycap>/</Keycap> search
        </span>
      </p>
    </div>
  );
}

function Message({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-start gap-3 border-b border-line py-6 text-[13px] leading-5 text-dim">{children}</div>;
}

/**
 * A09, the briefs library: the desks outline, LIBRARY · N BRIEFS with Search briefs (/) and the
 * Date | Conviction sort, the list (the latest per desk, or one desk or a search in full with Load
 * more) whose selected brief opens its verdict, and the margin with the numbers traced and, pinned to
 * its foot, the snapshot note. It lists the showcases and this browser's own briefs only (D31).
 * Presentational: LibraryView fetches.
 */
export function LibraryBody({
  params,
  search,
  data,
  selectedId,
  refreshing = false,
  onSearch,
  onSort,
  onSelect,
  onLoadMore,
  onRetry,
  onClearSearch,
}: LibraryBodyProps) {
  const summary = data.kind === "grouped" || data.kind === "flat" ? data.summary : null;
  const runs = listedRuns(data);
  const selected = selectedId !== null && runs.some((r) => r.runId === selectedId) ? selectedId : (runs[0]?.runId ?? null);
  const searching = params.q.trim() !== "";
  const deskCount = params.desk !== null && summary ? summary.pillars[params.desk] : null;
  // What the view lists in all: one desk's briefs on a desk view (the totals count every desk).
  const viewCount = summary ? (deskCount ?? summary.total) : null;
  const deskName = params.desk ? ` on the ${DESK_LABEL[params.desk]} desk` : "";
  const column = useRef<HTMLDivElement>(null);
  useArrowsEnterList(column, selected);

  // Chosen by the view, not the data, so the column stays put while the list loads.
  const outline = isGrouped(params) ? (
    <Outline
      heading="On this page"
      items={DESK_ORDER.map((p) => ({ id: `desk-${p}`, label: DESK_LABEL[p], ...(summary ? { count: summary.pillars[p] } : {}) }))}
      meta={{ text: groupedMeta(params.sort) }}
    />
  ) : (
    <DeskNav params={params} summary={summary} />
  );

  let list: ReactNode;
  if (data.kind === "loading") {
    list = (
      <ul aria-label="Loading briefs" className={ROW}>
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className={cx(READING, "flex h-14 items-center border-b border-line")}>
            <span className="flex flex-1 flex-col gap-[7px]">
              <span className="block h-[14px] w-[52%] rounded-brief bg-canvas motion-safe:animate-pulse" />
              <span className="block h-[9px] w-[24%] rounded-brief bg-canvas motion-safe:animate-pulse" />
            </span>
          </li>
        ))}
      </ul>
    );
  } else if (data.kind === "error") {
    list = (
      <div className={ROW}>
        <div className={READING} role="alert">
          <Message>
            <p>{data.message}</p>
            {data.retry && onRetry ? (
              <Button size="sm" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
          </Message>
        </div>
      </div>
    );
  } else if (runs.length === 0 && !searching) {
    // Nothing to list: no briefs at all, or none on this desk while other desks have some.
    const elsewhere = params.desk !== null && data.summary.total > 0;
    list = (
      <div className={ROW}>
        <div className={READING}>
          <Message>
            <p>
              No briefs yet{deskName}. The showcases and the briefs you run in this browser are listed here; other visitors&apos;
              briefs never are.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              {elsewhere ? (
                <ButtonLink href={libraryHref({ ...params, desk: null })} variant="secondary" size="sm" hint={null}>
                  All {DESK_PLURAL(data.summary.total)}
                </ButtonLink>
              ) : null}
              <ButtonLink href="/" variant="quiet">
                Ask a question
              </ButtonLink>
            </div>
          </Message>
        </div>
      </div>
    );
  } else if (runs.length === 0) {
    list = (
      <div className={ROW}>
        <div className={READING}>
          <Message>
            <p>
              No brief{deskName} matches &ldquo;{params.q.trim()}&rdquo;.
            </p>
            {onClearSearch ? (
              <Button size="sm" onClick={onClearSearch}>
                Clear the search
              </Button>
            ) : null}
          </Message>
        </div>
      </div>
    );
  } else if (data.kind === "grouped") {
    list = DESK_ORDER.map((pillar, index) => (
      <section key={pillar} aria-labelledby={`desk-${pillar}`} className={ROW}>
        <div className={READING}>
          <GroupHead index={index} pillar={pillar} count={data.summary.pillars[pillar]} sort={params.sort} />
        </div>
        {data.groups[pillar].length === 0 ? (
          <p className={cx(READING, "border-b border-line py-3 text-[12px] text-dim")}>No briefs on this desk yet.</p>
        ) : (
          <ul className={ROW}>
            {data.groups[pillar].map((brief) => (
              <LibraryRow key={brief.runId} brief={brief} selected={brief.runId === selected} year={data.year} onSelect={onSelect} />
            ))}
          </ul>
        )}
      </section>
    ));
  } else {
    list = (
      <ul className={ROW}>
        {data.runs.map((brief) => (
          <LibraryRow key={brief.runId} brief={brief} selected={brief.runId === selected} year={data.year} onSelect={onSelect} />
        ))}
      </ul>
    );
  }

  const more =
    data.kind === "flat" && data.runs.length > 0 ? (
      <div className="flex items-center gap-4 py-5">
        {data.next !== null ? (
          <Button size="sm" onClick={onLoadMore} disabled={data.loadingMore || refreshing} aria-busy={data.loadingMore}>
            {data.loadingMore ? "Loading…" : "Load more"}
          </Button>
        ) : (
          <p className="text-[12px] text-dim">
            {data.runs.length === 1 ? "The only brief" : `All ${data.runs.length.toLocaleString("en-US")} briefs`} shown.
          </p>
        )}
        {data.moreError ? (
          <p role="alert" className="text-[12px] text-negative">
            {data.moreError}
          </p>
        ) : null}
      </div>
    ) : null;

  return (
    <div className={cx("w-full flex-1 px-4 pt-7 pb-16 md:grid md:px-0", GRID_COLUMNS_MD, "xl:grid", GRID_COLUMNS_XL)}>
      <div className="hidden md:col-start-2 md:row-start-1 md:block">
        <div className="sticky top-[84px]">{outline}</div>
      </div>
      {/*
        Rows are placed explicitly from 1280 px, so the pinned snapshot note can share the margin column.
        The last row takes the rest of the screen: under a short list the note still rests at its foot.
      */}
      <div
        ref={column}
        className="min-w-0 md:col-start-4 md:row-start-1 xl:col-[4/span_3] xl:grid xl:grid-cols-subgrid xl:grid-rows-[auto_auto_auto_1fr]"
        onKeyDown={moveBetweenBriefs}
      >
        <div className={cx(ROW, "xl:col-start-1 xl:row-start-1")}>
          <div className={READING}>
            <header className="flex flex-col gap-4 pb-[18px] sm:flex-row sm:items-end sm:justify-between">
              <div className="flex flex-col gap-[10px]">
                <MetaLine
                  desk="Library"
                  job={params.desk ? DESK_LABEL[params.desk] : summary ? DESK_PLURAL(summary.total) : "Briefs"}
                  extra={params.desk && deskCount !== null ? [DESK_PLURAL(deskCount)] : []}
                />
                <h1 className="font-serif text-[32px] leading-10 font-medium text-ink">Briefs</h1>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-4 pb-1">
                <div className="w-[260px] max-sm:w-full">
                  <Search
                    value={search}
                    onChange={(e) => onSearch?.(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape" && search !== "") {
                        e.preventDefault();
                        onClearSearch?.();
                      }
                    }}
                    shortcut
                    placeholder="Search briefs"
                    maxLength={200}
                  />
                </div>
                <SortToggle options={SORT_OPTIONS} value={params.sort} onChange={(v) => onSort?.(v)} />
              </div>
            </header>
            {summary ? <TraceLine summary={summary} desk={params.desk} /> : null}
            <DeskRow params={params} summary={summary} />
          </div>
          {summary ? (
            <div className={cx(MARGIN, "max-xl:hidden")}>
              <TraceNote summary={summary} desk={params.desk} />
            </div>
          ) : null}
        </div>
        <div className={cx(ROW, "xl:col-start-1 xl:row-start-2")}>
          <div className={READING}>
            <BriefListHeader columns="library" sortedBy={params.sort} />
          </div>
        </div>
        <div
          className={cx(ROW, "transition-opacity xl:col-start-1 xl:row-start-3", refreshing && "opacity-60")}
          aria-busy={data.kind === "loading" || refreshing}
        >
          {list}
        </div>
        <p role="status" aria-live="polite" className="sr-only">
          {viewCount !== null && searching && !refreshing ? `${DESK_PLURAL(viewCount)} match “${params.q.trim()}”.` : ""}
        </p>
        <div className={cx(ROW, "xl:col-start-1 xl:row-start-4")}>
          <div className={READING}>{more}</div>
          <div className={cx(MARGIN, "pt-8 xl:hidden")}>
            <SnapshotNote />
          </div>
        </div>
        {/*
          From 1280 px: the margin beside the list, with the snapshot note held at the foot of the screen.
          Size containment keeps it from growing the rows it spans; it only stretches over them.
        */}
        <div className="pointer-events-none hidden [contain:size] xl:col-start-3 xl:row-[2/span_3] xl:flex xl:flex-col">
          <div className="pointer-events-auto sticky bottom-12 mt-auto pt-8">
            <SnapshotNote />
          </div>
        </div>
      </div>
    </div>
  );
}
