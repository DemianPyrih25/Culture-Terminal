"use client";

import type { PickerCandidate, ScreenerAnswer, ScreenerColumn, ScreenerResult } from "@ct/contracts";
import { SCREENER_MARKETS_MAX, SCREENER_QUERY_MAX, SCREENER_ROWS_DEFAULT } from "@ct/contracts/values";
import { useState, type FormEvent, type ReactNode } from "react";
import { HumanCheckPanel, sharedHumanFetch, useHumanCheck } from "../protection/human-check-panel";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Checkbox, Input, Select } from "../ui/fields";
import { Icon } from "../ui/icons";
import { InlineState } from "../ui/inline-state";
import { Monogram } from "../ui/monogram";
import { Segmented } from "../ui/segmented";
import { useToast } from "../ui/toast";
import { CellDrawer } from "./cell-drawer";
import { ScreenerMapSlot } from "./map-slot";
import { DEFAULT_SORT, nextSort, requestsLine, type SortState } from "./model";
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

/** What one screen costs, for the line under the button (FEATURE_COSTS screener and taste_map_screener). */
export function costLine(markets: number, map: boolean): string {
  const max = 5 + markets + (map ? 13 : 0);
  return `Up to ${max} Qloo requests · no AI model · a repeat within the hour makes none`;
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
    <ul className="flex flex-col gap-2" aria-label="Candidates">
      {candidates.map((c) => (
        <li key={c.key}>
          <button
            type="button"
            onClick={() => onPick(c.key)}
            className="flex min-h-14 w-full items-center gap-3 rounded-control border border-line bg-surface px-4 py-2 text-left transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-md"
            data-candidate={c.key}
          >
            <Monogram name={c.name} size={32} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[15px] leading-6 font-semibold text-ink">{c.name}</span>
              <span className="truncate type-label text-ink-2">{c.disambiguation ?? "No other detail from Qloo"}</span>
            </span>
            <Icon name="chevron-right" size={16} className="shrink-0 text-ink-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Notes({ items }: { items: readonly string[] }) {
  return (
    <ul className="flex flex-col gap-2" aria-label="Limits of this screen">
      {items.map((note) => (
        <li key={note} className="flex gap-3 type-label text-ink-2">
          <span aria-hidden="true" className="mt-[7px] size-[5px] shrink-0 rounded-full bg-ink-3" />
          {note}
        </li>
      ))}
    </ul>
  );
}

/** The taste map's own calls at most, for the cost of adding it (FEATURE_COSTS.taste_map_screener). */
const MAP_CALLS_MAX = 13;

function AddMap({ onAdd, busy }: { onAdd: () => void; busy: boolean }) {
  return (
    <Card padding="default" className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" data-screen-map="offer">
      <div className="flex flex-col gap-1">
        <h3 className="type-label font-semibold text-ink">Category Taste Map</h3>
        <p className="type-label text-ink-2">
          Places the top brands by how alike their audiences are, and measures distinctiveness. Up to {MAP_CALLS_MAX} more Qloo requests, no AI model; the
          table&apos;s own requests come from the cache.
        </p>
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
    <section className="flex flex-col gap-4" aria-labelledby="screen-title" data-screen="ok">
      <header className="flex flex-col gap-1">
        <h2 id="screen-title" className="type-title text-ink max-md:type-title-sm">
          {screen.seed.label}
        </h2>
        <p className="type-label text-ink-2">
          {kind} · {screen.rows.length} brands
          {screen.markets.length > 0 ? ` · ${screen.markets.map((m) => m.label).join(", ")}` : ""} · {requestsLine(screen)}
        </p>
      </header>
      <Notes items={screen.limitations} />
      {screen.rows.length === 0 ? (
        <InlineState tone="neutral" icon="search-x">
          Qloo returned no brands for this screen. Try a broader category, or a seed brand.
        </InlineState>
      ) : (
        <Card padding="default">
          <ScreenerTable
            caption={caption}
            columns={screen.columns}
            rows={screen.rows}
            sort={sort}
            onSort={(key) => setSort((s) => nextSort(s, key))}
            onCell={(rowKey, col) => setOpen({ rowKey, column: col })}
            selected={open}
          />
          <p className="mt-3 type-caption text-ink-2">Select any value to see the Qloo requests behind it. No composite score: each column stands on its own.</p>
        </Card>
      )}
      {screen.map ? (
        <ScreenerMapSlot map={screen.map} screen={screen} />
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
  /** A taste map is being added to the screen on show. */
  adding: boolean;
}

function AnswerView({ status, onPick, onCopied, onAddMap, adding }: AnswerViewProps): ReactNode {
  switch (status.kind) {
    case "idle":
      return null;
    case "loading":
      return (
        <InlineState tone="neutral" icon="loader-circle" data-screen="loading">
          Screening: finding the brands, then reading ages and markets. This takes a few seconds.
        </InlineState>
      );
    case "error":
      return (
        <InlineState tone="danger" data-screen="error">
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
            <Card padding="lg" className="flex flex-col gap-4" data-screen={a.kind}>
              <h2 className="type-title text-ink max-md:type-title-sm">{a.kind === "pick" ? "Which one?" : "Not found"}</h2>
              <p className="type-body text-ink-2">{a.message}</p>
              {a.candidates.length > 0 ? <Candidates candidates={a.candidates} onPick={onPick} /> : null}
            </Card>
          );
        case "unavailable":
          return (
            <InlineState tone="neutral" icon={a.retryAfterS !== null ? "clock-4" : "circle-pause"} data-screen="unavailable">
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
    <div className="flex flex-col gap-6 pt-10 pb-12 max-md:gap-4 max-md:pt-6 max-md:pb-8">
      <header className="flex max-w-[744px] flex-col gap-2 pb-3">
        <h1 className="type-display-m text-ink max-md:type-display-m-sm">Brand screener</h1>
        <p className="type-lead text-ink-2 max-md:text-[16px] max-md:leading-6">
          Rank the brands of a category, or the brands nearest a seed brand, on taste fit, next-gen tilt, metro breadth, popularity and how far they sit under the radar.
        </p>
      </header>

      <Card className="flex max-w-[744px] flex-col gap-4" aria-labelledby="screen-form-title">
        <h2 id="screen-form-title" className="sr-only">
          What to screen
        </h2>
        <form onSubmit={submit} className="flex flex-col gap-4" data-screener-form="true">
          <Segmented options={SEED_OPTIONS} value={by} onChange={setBy} label="Screen by" />
          <Input
            label={by === "tag" ? "Category" : "Seed brand"}
            name="q"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={SCREENER_QUERY_MAX}
            autoComplete="off"
            spellCheck={false}
            placeholder={by === "tag" ? "A Qloo brand category, e.g. energy drinks" : "A brand name"}
            error={fieldError ?? undefined}
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <Select
              label={`Markets for metro breadth (${markets.length} of ${SCREENER_MARKETS_MAX})`}
              value=""
              disabled={markets.length >= SCREENER_MARKETS_MAX}
              onChange={(e) => {
                const id = e.target.value;
                if (id) setMarkets((m) => (m.length < SCREENER_MARKETS_MAX && !m.includes(id) ? [...m, id] : m));
              }}
              className="sm:flex-1"
            >
              <option value="">{markets.length >= SCREENER_MARKETS_MAX ? "Four markets picked" : "Add a market"}</option>
              {free.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
            <Select label="Brands" value={String(rows)} onChange={(e) => setRows(Number(e.target.value))} className="sm:w-[120px]">
              {ROW_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </div>
          {markets.length > 0 ? (
            <ul className="flex flex-wrap gap-2" aria-label="Markets picked">
              {markets.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => setMarkets((m) => m.filter((x) => x !== id))}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 type-label text-ink hover:border-line-strong"
                    aria-label={`Remove ${labelOf(id)}`}
                  >
                    {labelOf(id)}
                    <Icon name="x" size={14} className="text-ink-2" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <Checkbox checked={map} onChange={(e) => setMap(e.target.checked)}>
            Measure distinctiveness with the taste map (up to 13 more Qloo requests)
          </Checkbox>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            <Button type="submit" variant="primary" loading={status.kind === "loading"} disabled={status.kind === "loading"}>
              Run screen
            </Button>
            <span className="type-caption text-ink-2">{costLine(markets.length, map)}</span>
          </div>
        </form>
        <HumanCheckPanel check={human} />
      </Card>

      <AnswerView status={status} onPick={(key) => void run(key)} onCopied={show} onAddMap={() => void addMap()} adding={adding} />
      {toast}
    </div>
  );
}
