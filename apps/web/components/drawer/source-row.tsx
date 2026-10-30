"use client";

import { useId, useState } from "react";
import type { BriefSource, RequestRef } from "../../lib/brief";
import { Button, buttonClassName, copyText, cx, Icon } from "../ui";
import { isMockReference, overpassLink, publicRequestLink, QLOO_IDS_LINE, requestCopy, type CallQuery } from "./request-copy";
import { freshnessText, isPublicLookup, requestPairs, sourceDescription, sourceLine } from "./source-copy";

/**
 * C/SourceRow: one lookup. Its description and chevron toggle it; under them the endpoint line and how
 * fresh it is. Open, the request block (redacted parameters with names where Qloo entity ids were, and
 * the short request id), then "Copy id" and "Copy request" (R8: the ids stay on our server; the request
 * id identifies the call). An SEC EDGAR or US Census lookup (Part 9) shows its reference, and "Open at the
 * source" and "Copy URL" with the public request URL. An OpenStreetMap lookup (R6) shows its Overpass
 * query and "Open in Overpass Turbo". No key is ever shown.
 */

/** What a row needs of a lookup: a Sources entry, or a footnote's request the run did not stream. */
export type Lookup = Pick<
  BriefSource,
  "qlooCallId" | "endpoint" | "filterType" | "filterLabel" | "refs" | "params" | "rows" | "cache" | "cacheAgeMs" | "at" | "requestId" | "shortRequestId"
> &
  Partial<Pick<BriefSource, "source" | "host">>;

/** A footnote's request as a lookup: its Sources entry when the run streamed it. */
export function lookupOf(request: RequestRef, sources: readonly BriefSource[]): Lookup | null {
  const source = request.sourceIndex === null ? undefined : sources[request.sourceIndex];
  if (source) return source;
  if (request.endpoint === null) return null;
  return {
    qlooCallId: request.qlooCallId,
    ...(request.source ? { source: request.source } : {}),
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
  /** The call's full query, for an exact copy, a public link or an Overpass query. */
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
  const copyable = requestCopy(lookup, query);
  const link = publicRequestLink(lookup, query);
  const overpass = overpassLink(lookup, query);
  const publicSource = isPublicLookup(lookup.source);
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
              {publicSource ? "Copy reference" : "Copy id"}
            </Button>
          ) : null}
          {link ? (
            <>
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                data-public-url={link.url}
                className={buttonClassName("secondary", "sm")}
              >
                Open at the source
              </a>
              <Button variant="secondary" size="sm" icon="copy" onClick={() => copy(link.url)} data-url-exact={link.exact}>
                Copy URL
              </Button>
            </>
          ) : null}
          {overpass ? (
            <>
              <a
                href={overpass.url}
                target="_blank"
                rel="noopener noreferrer"
                data-overpass-url={overpass.url}
                className={buttonClassName("secondary", "sm")}
              >
                Open in Overpass Turbo
              </a>
              <Button variant="secondary" size="sm" icon="copy" onClick={() => copy(overpass.query)}>
                Copy query
              </Button>
            </>
          ) : null}
          {copyable ? (
            <Button variant="secondary" size="sm" icon="copy" onClick={() => copy(copyable.text)} data-request-copy={copyable.text} data-request-exact={copyable.exact}>
              Copy request
            </Button>
          ) : null}
        </div>
        {overpass ? (
          <pre className="max-h-48 overflow-auto rounded-sm bg-sunken p-3 font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-ink [overflow-wrap:anywhere]" data-overpass-query>
            {overpass.query}
          </pre>
        ) : null}
        {copyable ? <p className="type-caption text-ink-2">{QLOO_IDS_LINE}</p> : null}
        {publicSource ? <p className="type-caption text-ink-2">{publicNote(lookup, link ?? (overpass ? {} : null))}</p> : null}
      </div>
    </li>
  );
}

/** The line under a public lookup: how to repeat it, and what a rebuilt or test link means. */
export function publicNote(lookup: Pick<Lookup, "source" | "requestId">, link: { exact?: boolean } | null): string {
  if (lookup.source === "osm") {
    if (isMockReference(lookup.requestId)) return "Test data: this lookup was answered with invented places, not by OpenStreetMap.";
    const how = "A public OpenStreetMap request (Overpass API): no key needed. Map data © OpenStreetMap contributors, under the Open Database License (ODbL).";
    return link ? how : `${how} The exact query was not recorded for this lookup.`;
  }
  if (isMockReference(lookup.requestId)) return "Test data: this lookup was answered with invented figures, not by the SEC or the Census.";
  const how =
    lookup.source === "sec"
      ? "A public SEC EDGAR request: no key needed. Scripts must send a User-Agent naming you and a contact email."
      : "A public US Census Data API request. The Census asks for a free API key: add &key= with your own to repeat it.";
  if (!link) return `${how} The exact request was not recorded for this lookup.`;
  return link.exact !== false ? how : `${how} Some values were shortened in the trace, so the link is a sketch, not an exact replay.`;
}
