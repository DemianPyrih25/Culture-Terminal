"use client";

import type { PickerCandidate, ScreenerAnswer, ScreenerColumn, ScreenerResult } from "@ct/contracts";
import { SCREENER_MARKETS_MAX, SCREENER_QUERY_MAX, SCREENER_ROWS_DEFAULT } from "@ct/contracts/values";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { HumanCheckPanel, sharedHumanFetch, useHumanCheck } from "../protection/human-check-panel";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Checkbox, Input, Select } from "../ui/fields";
import { Icon } from "../ui/icons";
import { InlineState } from "../ui/inline-state";
import { Monogram } from "../ui/monogram";
import { Segmented } from "../ui/segmented";
import { Skeleton } from "../ui/skeleton";
import { useToast } from "../ui/toast";
import { CellDrawer } from "./cell-drawer";
import { ScreenerMapSlot } from "./map-slot";
import { DEFAULT_SORT, nextSort, type SortState } from "./model";
import { ScreenerTable } from "./screener-table";

/**
 * /screener (PLAN §5.5, §8.1): a category or a seed brand, up to four markets, the row count and the
 * optional taste map; POST /api/screener through the shared human check (Turnstile, §10.3); then the
 * sortable table, its limits above it, and How we know for any cell. A tie or a miss offers choices
 * and applies none (D20); a pause or a limit says why and when.
 */

export interface MarketOption {
  id: string;
  label: string;
}

type SeedBy = "tag" | "brand";
type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "answer"; answer: ScreenerAnswer }
  | { kind: "error"; message: string };

const ROW_OPTIONS = [10, 15, 20, 25] as const;
const SEED_OPTIONS = [
  { value: "tag" as const, label: "Category" },
  { value: "brand" as const, label: "Seed brand" },
];

/** A section label: small caps, tracked, quiet (Ledger). */
const SECTION_LABEL = "text-[11px] leading-4 font-semibold tracking-[0.1em] text-ink-2 uppercase";

/**
 * The day's screens are used up (the server's daily budget answer). Limits and usage live on Settings
 * only, so the page says it once, calmly, and links there.
 */
export function isDailyLimit(message: string): boolean {
  return message.startsWith("Today's Qloo requests are used up");
}

/** When the screen was put together, in UTC ("Oct 31, 2026, 14:08 UTC"); a saved copy's own dates are in the limits. */
function screenedAt(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "just now";
  const d = new Date(t);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${date}, ${time} UTC`;
}

async function postScreen(body: unknown): Promise<Status> {
  try {
    const res = await sharedHumanFetch()("/api/screener", {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const reply = (await res.json().catch(() => null)) as (ScreenerAnswer & { error?: unknown }) | { error?: unknown } | null;
    if (res.ok && reply && "kind" in reply) return { kind: "answer", answer: reply };
    const error = reply && typeof reply.error === "string" ? reply.error : "The screen could not be run. Try again.";
    return { kind: "error", message: error };
  } catch {
    return { kind: "error", message: "The screen could not be sent. Check your connection and try again." };
  }
}

function Candidates({ candidates, onPick }: { candidates: readonly PickerCandidate[]; onPick: (key: string) => void }) {
  return (
    <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-control border border-line bg-surface" aria-label="Candidates">
      {candidates.map((c, i) => (
        <li key={c.key} className="animate-rise" style={{ animationDelay: `${Math.min(i * 30, 240)}ms` }}>
          <button
            type="button"
            onClick={() => onPick(c.key)}
            className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-canvas focus-visible:bg-canvas active:bg-sunken"
            data-candidate={c.key}
          >
            <Monogram name={c.name} size={32} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[15px] leading-6 font-medium text-ink">{c.name}</span>
              <span className="truncate type-caption text-ink-3">{c.disambiguation ?? "No other detail from Qloo"}</span>
            </span>
            <Icon name="chevron-right" size={16} className="shrink-0 text-ink-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Notes({ items }: { items: readonly string[] }) {
  const [shown, setShown] = useState(true);
  const reduce = useReducedMotion();
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-4 rounded-sm border border-line bg-canvas px-6 py-5">
      <div className="flex items-center gap-2">
        <Icon name="triangle-alert" size={14} className="text-caution" />
        <h3 className="text-[14px] leading-5 font-semibold text-ink">Limits of this screen</h3>
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          aria-expanded={shown}
          aria-controls="screen-limits"
          className="ml-auto type-label font-medium text-accent transition-colors duration-150 hover:text-accent-hover"
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {shown ? (
          <motion.div
            key="limits"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <ul id="screen-limits" className="grid gap-x-10 gap-y-2 lg:grid-cols-2" aria-label="Limits of this screen">
              {items.map((note) => (
                <li key={note} className="flex gap-2 text-[13px] leading-5 text-ink-2">
                  <span aria-hidden="true" className="shrink-0 text-ink-3">
                    —
                  </span>
                  {note}
                </li>
              ))}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** The brands the taste map places at most (contracts: k ≤ 14). */
const MAP_BRANDS_MAX = 14;

function AddMap({ onAdd, busy }: { onAdd: () => void; busy: boolean }) {
  return (
    <Card padding="default" className="flex animate-rise flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8" data-screen-map="offer">
      <div className="flex flex-col gap-1.5">
        <h3 className={SECTION_LABEL}>Category Taste Map</h3>
        <p className="font-mono text-[12px] leading-4 text-ink-2">Top {MAP_BRANDS_MAX} brands · distinctiveness</p>
      </div>
      <Button variant="secondary" onClick={onAdd} loading={busy} disabled={busy} className="shrink-0">
        Draw the taste map
      </Button>
    </Card>
  );
}

function Result({ screen, onCopied, onAddMap, busy }: { screen: ScreenerResult; onCopied: (m: string) => void; onAddMap?: () => void; busy: boolean }) {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [open, setOpen] = useState<{ rowKey: string; column: ScreenerColumn } | null>(null);
  const row = open ? (screen.rows.find((r) => r.key === open.rowKey) ?? null) : null;
  const column = open ? (screen.columns.find((c) => c.key === open.column) ?? null) : null;
  const kind = screen.seed.by === "tag" ? "Category screen" : "Brands near a seed";
  const caption = `${kind}: ${screen.seed.label}, ${screen.rows.length} brands`;
  return (
    <section className="flex animate-rise flex-col gap-5" aria-labelledby="screen-title" data-screen="ok">
      <header className="flex flex-col gap-3 border-b border-line-strong pb-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
        <div className="flex min-w-0 flex-col gap-2.5">
          <span className={SECTION_LABEL}>{kind}</span>
          <h2 id="screen-title" className="font-display text-[28px] leading-9 font-medium tracking-[-0.01em] text-ink max-md:text-[24px] max-md:leading-8">
            {screen.seed.label}
          </h2>
          <p className="font-mono text-[12px] leading-4 text-ink-2">
            {screen.rows.length} brands
            {screen.markets.length > 0 ? ` · ${screen.markets.map((m) => m.label).join(", ")}` : ""}
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-sm bg-sunken px-2.5 py-1 font-mono text-[12px] leading-4 text-ink-2 sm:self-auto">
          <Icon name="clock-4" size={12} className="text-ink-3" />
          Screened {screenedAt(screen.createdAt)}
        </span>
      </header>
      <Notes items={screen.limitations} />
      {screen.rows.length === 0 ? (
        <InlineState tone="neutral" icon="search-x">
          Qloo returned no brands for this screen. Try a broader category, or a seed brand.
        </InlineState>
      ) : (
        <ScreenerTable
          caption={caption}
          columns={screen.columns}
          rows={screen.rows}
          sort={sort}
          onSort={(key) => setSort((s) => nextSort(s, key))}
          onCell={(rowKey, col) => setOpen({ rowKey, column: col })}
          selected={open}
        />
      )}
      {screen.map ? (
        <div className="animate-rise">
          <ScreenerMapSlot map={screen.map} screen={screen} />
        </div>
      ) : onAddMap && screen.rows.length > 0 && !screen.requests.some((r) => r.purpose === "taste_map") ? (
        <AddMap onAdd={onAddMap} busy={busy} />
      ) : null}
      <CellDrawer screen={screen} row={row} column={column} onClose={() => setOpen(null)} onCopied={onCopied} />
    </section>
  );
}

interface AnswerViewProps {
  status: Status;
  onPick: (key: string) => void;
  onCopied: (m: string) => void;
  onAddMap: () => void;
  /** Sends the last screen again after an error. */
  onRetry: () => void;
  /** A taste map is being added to the screen on show. */
  adding: boolean;
}

/** The table's shape while the screen runs: a head and five pulsing rows. */
function LoadingTable() {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-control border border-line bg-surface">
      <div className="flex h-10 items-center gap-6 border-b border-line bg-sunken/60 px-4">
        <Skeleton className="h-2 w-4" />
        <Skeleton className="h-2 w-24 flex-1" />
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-2 w-14 max-sm:hidden" />
        ))}
      </div>
      {Array.from({ length: 5 }, (_, r) => (
        <div key={r} className="flex h-11 items-center gap-6 border-b border-line px-4 last:border-b-0">
          <Skeleton className="h-2.5 w-4" />
          <Skeleton className="h-2.5 w-32 flex-1" />
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-2.5 w-14 max-sm:hidden" />
          ))}
        </div>
      ))}
    </div>
  );
}

function AnswerView({ status, onPick, onCopied, onAddMap, onRetry, adding }: AnswerViewProps): ReactNode {
  switch (status.kind) {
    case "idle":
      return null;
    case "loading":
      return (
        <div className="flex animate-rise flex-col gap-4" data-screen="loading">
          <InlineState tone="neutral" icon="loader-circle">
            Screening…
          </InlineState>
          <LoadingTable />
        </div>
      );
    case "error":
      return (
        <InlineState
          tone="danger"
          className="animate-rise"
          data-screen="error"
          action={
            <Button variant="quiet" size="sm" onClick={onRetry}>
              Try again
            </Button>
          }
        >
          {status.message}
        </InlineState>
      );
    case "answer": {
      const a = status.answer;
      switch (a.kind) {
        case "ok":
          return <Result key={a.screen.createdAt + a.screen.seed.label} screen={a.screen} onCopied={onCopied} onAddMap={onAddMap} busy={adding} />;
        case "pick":
        case "not_found":
          return (
            <section className="flex max-w-[744px] animate-rise flex-col gap-4 border-t border-line pt-8" data-screen={a.kind}>
              <h2 className="type-title text-ink max-md:type-title-sm">{a.kind === "pick" ? "Which one?" : "Not found"}</h2>
              <p className="type-body text-ink-2">{a.message}</p>
              {a.candidates.length > 0 ? <Candidates candidates={a.candidates} onPick={onPick} /> : null}
            </section>
          );
        case "unavailable":
          if (isDailyLimit(a.message))
            return (
              <InlineState
                tone="neutral"
                icon="clock-4"
                className="animate-rise"
                data-screen="unavailable"
                action={
                  <Link href="/settings" prefetch={false} className="type-label font-medium whitespace-nowrap text-accent hover:text-accent-hover">
                    See plan
                  </Link>
                }
              >
                You&apos;ve used today&apos;s screens. They reset at 00:00 UTC.
              </InlineState>
            );
          return (
            <InlineState tone="neutral" icon={a.retryAfterS !== null ? "clock-4" : "circle-pause"} className="animate-rise" data-screen="unavailable">
              {a.message}
            </InlineState>
          );
      }
    }
  }
}

export interface ScreenerViewProps {
  markets: readonly MarketOption[];
  initial?: { by: SeedBy; query: string };
}

export function ScreenerView({ markets: marketOptions, initial }: ScreenerViewProps) {
  const human = useHumanCheck();
  const { show, toast } = useToast();
  const [by, setBy] = useState<SeedBy>(initial?.by ?? "tag");
  const [query, setQuery] = useState(initial?.query ?? "");
  const [markets, setMarkets] = useState<string[]>([]);
  const [rows, setRows] = useState<number>(SCREENER_ROWS_DEFAULT);
  const [map, setMap] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [fieldError, setFieldError] = useState<string | null>(null);
  /** The request behind the screen on show, so the taste map can be added to that same screen. */
  const [last, setLast] = useState<Record<string, unknown> | null>(null);
  const [adding, setAdding] = useState(false);
  /** The pick of the last screen sent, so Try again resends the same choice. */
  const [lastPick, setLastPick] = useState<string | null>(null);

  const run = async (pick: string | null) => {
    const text = query.trim();
    if (text === "") {
      setFieldError(by === "tag" ? "Type a category, for example a kind of product." : "Type a brand name.");
      return;
    }
    setFieldError(null);
    setStatus({ kind: "loading" });
    const seed = by === "tag" ? { by, query: text } : { by, name: text };
    const body = { seed, markets, rows, map, pick };
    setLast(body);
    setLastPick(pick);
    setStatus(await postScreen(body));
  };
  // The map only on the reader's ask: the same screen again with map on. Its table calls come from
  // the Qloo cache, so the new cost is the map's own similarity calls.
  const addMap = async () => {
    if (last === null) return;
    const body = { ...last, map: true };
    setAdding(true);
    const next = await postScreen(body);
    setAdding(false);
    if (next.kind === "answer" && next.answer.kind === "ok") {
      setLast(body);
      setMap(true);
      setStatus(next);
    } else if (next.kind === "answer" && next.answer.kind === "unavailable") show(next.answer.message);
    else if (next.kind === "error") show(next.message);
    else setStatus(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(null);
  };
  const free = marketOptions.filter((m) => !markets.includes(m.id));
  const labelOf = (id: string) => marketOptions.find((m) => m.id === id)?.label ?? id;

  return (
    <div className="flex flex-col gap-12 pt-9 pb-16 max-md:gap-6 max-md:pt-6 max-md:pb-10">
      <header className="flex animate-rise flex-wrap items-end justify-between gap-x-6 gap-y-2 lg:max-w-[820px]">
        <h1 className="type-display-m text-ink max-md:type-display-m-sm">Brand screener</h1>
        <Link
          href="/method"
          prefetch={false}
          className="inline-flex items-center gap-1 text-[13px] leading-5 font-semibold text-accent transition-colors duration-150 hover:text-accent-hover"
        >
          Method
          <Icon name="arrow-right" size={13} />
        </Link>
      </header>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
        <Card className="flex min-w-0 flex-1 animate-rise flex-col gap-5 [animation-delay:40ms] lg:max-w-[820px]" aria-labelledby="screen-form-title">
          <h2 id="screen-form-title" className="sr-only">
            What to screen
          </h2>
          <form onSubmit={submit} className="flex flex-col gap-5" data-screener-form="true">
            <Segmented options={SEED_OPTIONS} value={by} onChange={setBy} label="Screen by" />
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <Input
                label={by === "tag" ? "Category" : "Seed brand"}
                name="q"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                maxLength={SCREENER_QUERY_MAX}
                autoComplete="off"
                spellCheck={false}
                placeholder={by === "tag" ? "Energy drinks" : "A brand name"}
                help={
                  <span className="flex justify-end">
                    <span className="shrink-0 font-mono text-ink-3 tabular-nums">
                      {query.length} / {SCREENER_QUERY_MAX}
                    </span>
                  </span>
                }
                error={fieldError ?? undefined}
                className="sm:flex-1"
              />
              <Select label="Brands" value={String(rows)} onChange={(e) => setRows(Number(e.target.value))} className="sm:w-[140px]">
                {ROW_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-3">
              <Select
                label={`Markets for metro breadth (${markets.length} of ${SCREENER_MARKETS_MAX})`}
                value=""
                disabled={markets.length >= SCREENER_MARKETS_MAX}
                onChange={(e) => {
                  const id = e.target.value;
                  if (id) setMarkets((m) => (m.length < SCREENER_MARKETS_MAX && !m.includes(id) ? [...m, id] : m));
                }}
                className="sm:max-w-[360px]"
              >
                <option value="">{markets.length >= SCREENER_MARKETS_MAX ? "Four markets picked" : "Add a market"}</option>
                {free.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </Select>
              {markets.length > 0 ? (
                <ul className="flex flex-wrap gap-2" aria-label="Markets picked">
                  {markets.map((id) => (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => setMarkets((m) => m.filter((x) => x !== id))}
                        className="inline-flex h-7 animate-rise items-center gap-1.5 rounded-sm border border-map-2 bg-accent-soft pr-2 pl-2.5 text-[12px] leading-4 font-semibold text-accent transition-colors duration-150 hover:bg-map-1 active:bg-map-2"
                        aria-label={`Remove ${labelOf(id)}`}
                      >
                        {labelOf(id)}
                        <Icon name="x" size={12} className="text-accent" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <Checkbox checked={map} onChange={(e) => setMap(e.target.checked)}>
              Taste map (distinctiveness)
            </Checkbox>
            <div className="flex border-t border-line pt-5 max-sm:flex-col">
              <Button type="submit" variant="primary" icon="play" trailing={null} loading={status.kind === "loading"} disabled={status.kind === "loading"}>
                Run screen
              </Button>
            </div>
          </form>
          <HumanCheckPanel check={human} />
        </Card>
      </div>

      <AnswerView
        status={status}
        onPick={(key) => void run(key)}
        onCopied={show}
        onAddMap={() => void addMap()}
        onRetry={() => void run(lastPick)}
        adding={adding}
      />
      {toast}
    </div>
  );
}
