"use client";

import { useId, useState } from "react";
import type { BriefSource, RequestRef } from "../../lib/brief";
import { Button, copyText, cx, Icon } from "../ui";
import { requestCurl, type CallQuery } from "./curl";
import { freshnessText, requestPairs, sourceDescription, sourceLine } from "./source-copy";

/**
 * C/SourceRow: one Qloo lookup. Its description and chevron toggle it; under them the endpoint line and
 * how fresh it is. Open, the request block (redacted parameters and the short request id), then "Copy id"
 * and "Copy as curl".
 */

/** What a row needs of a lookup: a Sources entry, or a footnote's request the run did not stream. */
export type Lookup = Pick<
  BriefSource,
  "qlooCallId" | "endpoint" | "filterType" | "filterLabel" | "refs" | "params" | "rows" | "cache" | "cacheAgeMs" | "at" | "requestId" | "shortRequestId"
>;

/** A footnote's request as a lookup: its Sources entry when the run streamed it. */
export function lookupOf(request: RequestRef, sources: readonly BriefSource[]): Lookup | null {
  const source = request.sourceIndex === null ? undefined : sources[request.sourceIndex];
  if (source) return source;
  if (request.endpoint === null) return null;
  return {
    qlooCallId: request.qlooCallId,
    endpoint: request.endpoint,
    filterType: request.filterType,
    filterLabel: request.filterLabel,
    refs: [],
    params: request.params,
    rows: request.rows,
    cache: request.cache ?? "hit",
    cacheAgeMs: null,
    at: "",
    requestId: request.requestId,
    shortRequestId: request.shortRequestId,
  };
}

export interface SourceRowProps {
  lookup: Lookup;
  /** The call's full query, for an exact curl. */
  query?: CallQuery | null;
  defaultOpen?: boolean;
  /** Names for the run's refs (refNames), so "R1" in a parameter reads as its name. */
  names?: ReadonlyMap<string, string>;
  /** Says "Copied" (the drawer's toast). */
  onCopied?: (message: string) => void;
}

export function SourceRow({ lookup, query, defaultOpen = false, names, onCopied }: SourceRowProps) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const curl = requestCurl(lookup, query);
  const copy = (text: string) =>
    void copyText(text).then((ok) => onCopied?.(ok ? "Copied" : "Copy failed: select the text instead"));
  return (
    <li className="rounded-control border border-line bg-surface" data-source-row={lookup.qlooCallId}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-col gap-1 rounded-control px-4 py-[13px] text-left"
      >
        <span className="flex w-full items-start gap-3">
          <span className="min-w-0 flex-1 text-[14px] leading-5 font-semibold text-ink">{sourceDescription(lookup)}</span>
          <Icon name={open ? "chevron-up" : "chevron-down"} size={16} className="mt-0.5 shrink-0 text-ink-2" />
        </span>
        <span className="flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="min-w-0 font-mono text-[12px] leading-[18px] text-ink-2 [overflow-wrap:anywhere]">{sourceLine(lookup)}</span>
          <span className="text-[12px] leading-4 text-ink-2">{freshnessText(lookup)}</span>
        </span>
      </button>
      <div id={id} hidden={!open} className="flex flex-col gap-3 px-4 pb-4">
        <dl className="flex flex-col gap-2 rounded-sm bg-sunken p-3 font-mono text-[12px] leading-[18px] md:grid md:grid-cols-[max-content_minmax(0,1fr)] md:gap-x-3 md:gap-y-0">
          {requestPairs(lookup, names).map(([k, v]) => (
            <div key={k} className="flex flex-col md:contents">
              <dt className="whitespace-nowrap text-ink-2 md:min-w-[136px]">{k}</dt>
              <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{v}</dd>
            </div>
          ))}
        </dl>
        <div className={cx("flex flex-wrap items-center gap-2")}>
          {lookup.requestId ? (
            <Button variant="secondary" size="sm" icon="copy" onClick={() => copy(lookup.requestId ?? "")}>
              Copy id
            </Button>
          ) : null}
          {curl ? (
            <Button variant="secondary" size="sm" icon="copy" onClick={() => copy(curl.command)} data-curl={curl.command} data-curl-exact={curl.exact}>
              Copy as curl
            </Button>
          ) : null}
        </div>
        {curl ? <p className="type-caption text-ink-2">The curl reads your own key from $QLOO_API_KEY.</p> : null}
      </div>
    </li>
  );
}
