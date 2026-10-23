"use client";

import type { Pillar } from "@ct/contracts";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BriefsError, fetchBriefs, type BriefList, type BriefSort, type BriefSummary } from "./briefs-client";
import { DESK_ORDER } from "./format";
import { LATEST_PER_DESK, LibraryBody, type LibraryData, type LibrarySummary } from "./library-body";
import { isGrouped, libraryHref, readLibraryParams, type LibraryParams } from "./library-params";

/** Briefs per page of a flat list. */
export const LIBRARY_PAGE_SIZE = 20;
/** How long the search waits after the last key before it asks. */
const SEARCH_DELAY_MS = 250;

const summaryOf = (list: BriefList): LibrarySummary => ({
  total: list.total,
  pillars: list.pillars,
  numbersTraced: list.numbersTraced,
  pillarsTraced: list.pillarsTraced,
});

function failure(err: unknown): { message: string; retry: boolean } {
  return err instanceof BriefsError
    ? { message: err.message, retry: err.retry }
    : { message: "The briefs could not be loaded.", retry: true };
}

/** The first view of the library for these params: every desk's latest, or one flat page. */
async function loadView(params: LibraryParams, signal: AbortSignal): Promise<LibraryData> {
  const year = new Date().getUTCFullYear();
  if (isGrouped(params)) {
    const lists = await Promise.all(
      DESK_ORDER.map((pillar) => fetchBriefs({ limit: LATEST_PER_DESK, sort: params.sort, pillar }, { signal })),
    );
    const groups = Object.fromEntries(DESK_ORDER.map((p, i) => [p, lists[i]?.runs ?? []])) as Record<Pillar, BriefSummary[]>;
    return { kind: "grouped", groups, summary: summaryOf(lists[0]!), year };
  }
  const list = await fetchBriefs({ limit: LIBRARY_PAGE_SIZE, sort: params.sort, q: params.q, pillar: params.desk }, { signal });
  return { kind: "flat", runs: list.runs, next: list.next, summary: summaryOf(list), year, loadingMore: false, moreError: null };
}

export interface LibraryViewProps {
  /** The view the URL asked for. */
  initial: LibraryParams;
}

/**
 * The briefs library (A09), live: the list is fetched in the browser because it names this browser's
 * own runs (D31). The search runs as you type, a little behind; sort and search stay in the URL
 * without a navigation, and a navigation to another view (the top bar's Briefs) starts the list over.
 */
export function LibraryView({ initial }: LibraryViewProps) {
  const searchParams = useSearchParams();
  const [params, setParams] = useState<LibraryParams>(initial);
  const [search, setSearch] = useState(initial.q);
  const [attempt, setAttempt] = useState(0);
  // The data with the view it was loaded for: while a new view loads, the old one stays, dimmed.
  const [loaded, setLoaded] = useState<{ key: string; data: LibraryData }>({ key: "", data: { kind: "loading" } });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const more = useRef<AbortController | null>(null);
  // The library URL this view last wrote or read: any other is a navigation to follow.
  const shown = useRef(libraryHref(initial));
  const viewKey = `${libraryHref(params)}#${attempt}`;
  const data = loaded.data;
  const refreshing = loaded.key !== viewKey && data.kind !== "loading";

  // The search follows the field after a pause.
  useEffect(() => {
    const q = search.trim();
    if (q === params.q) return;
    const timer = setTimeout(() => setParams((p) => ({ ...p, q })), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search, params.q]);

  // The URL carries the view; replaceState keeps it without a navigation.
  useEffect(() => {
    const href = libraryHref(params);
    shown.current = href;
    if (`${window.location.pathname}${window.location.search}` !== href) window.history.replaceState(null, "", href);
  }, [params]);

  // A navigation to another view of this page (a link to /briefs) keeps it mounted: start over from the URL.
  useEffect(() => {
    const next = readLibraryParams(Object.fromEntries(searchParams.entries()));
    const href = libraryHref(next);
    if (href === shown.current) return;
    shown.current = href;
    more.current?.abort();
    setParams(next);
    setSearch(next.q);
    setSelectedId(null);
  }, [searchParams]);

  useEffect(() => {
    const controller = new AbortController();
    loadView(params, controller.signal)
      .then((next) => {
        setLoaded({ key: viewKey, data: next });
        setSelectedId(null);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setLoaded({ key: viewKey, data: { kind: "error", ...failure(err) } });
      });
    return () => {
      controller.abort();
      more.current?.abort();
    };
  }, [params, viewKey]);

  function loadMore() {
    if (data.kind !== "flat" || data.next === null || data.loadingMore || refreshing) return;
    // The page belongs to the view on screen: a later view drops it.
    const forKey = loaded.key;
    const before = data.next;
    const controller = new AbortController();
    more.current = controller;
    const update = (change: (current: Extract<LibraryData, { kind: "flat" }>) => LibraryData) =>
      setLoaded((l) => (l.key === forKey && l.data.kind === "flat" ? { ...l, data: change(l.data) } : l));
    update((current) => ({ ...current, loadingMore: true, moreError: null }));
    fetchBriefs({ limit: LIBRARY_PAGE_SIZE, sort: params.sort, q: params.q, pillar: params.desk, before }, { signal: controller.signal })
      .then((list) =>
        update((current) => ({ ...current, runs: [...current.runs, ...list.runs], next: list.next, summary: summaryOf(list), loadingMore: false })),
      )
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        update((current) => ({ ...current, loadingMore: false, moreError: failure(err).message }));
      });
  }

  return (
    <LibraryBody
      params={params}
      search={search}
      data={data}
      selectedId={selectedId}
      refreshing={refreshing}
      onSearch={setSearch}
      onSort={(sort: BriefSort) => setParams((p) => ({ ...p, sort }))}
      onSelect={setSelectedId}
      onLoadMore={loadMore}
      onRetry={() => {
        setLoaded({ key: "", data: { kind: "loading" } });
        setAttempt((n) => n + 1);
      }}
      onClearSearch={() => {
        setSearch("");
        setParams((p) => ({ ...p, q: "" }));
      }}
    />
  );
}
