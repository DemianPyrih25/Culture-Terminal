"use client";

import { Fragment, useState, type ReactNode } from "react";
import type { CacheStatus, QlooPath } from "@ct/contracts";
import { BADGE_LABEL, formatDuration, type BriefSource, type Footnote, type RequestRef } from "../../lib/brief";
import { ROUTE_LIVE } from "../../lib/routes";
import { cx } from "../ui";
import { useBrief, type CallQuery } from "./brief-context";
import { CopyButton } from "./copy-button";
import { curlCommand, hasShortenedParams, publicParams } from "./curl";
import { sentenceCase } from "./note-text";
import { RequestStamp } from "./stamp";

/**
 * The request inspector (Concept A, D36): what opens behind every number. The number itself (its
 * metric, or the figure or evidence bundle it cites), how it was made (a formula computed in code, or
 * "not measured" with the reason, never 0), the evidence bundles it rests on, and each Qloo request:
 * endpoint and filter type, the redacted parameters, rows, latency, cache status and age, the full
 * request id with copy, and "Copy as curl" with $QLOO_API_KEY in place of a key.
 */

/** One Qloo request as the inspector shows it, from a footnote's request or a Sources row. */
export interface RequestView {
  qlooCallId: string;
  /** "Source 6" in the Sources list; null when the run did not stream the call. */
  sourceNumber: number | null;
  endpoint: QlooPath | null;
  filterType: string | null;
  filterLabel: string | null;
  params: [string, string][];
  rows: number | null;
  ms: number | null;
  cache: CacheStatus | null;
  cacheLabel: string;
  requestId: string | null;
  status: number | null;
  error: string | null;
  evidenceIds: string[];
}

export function requestViewOf(request: RequestRef, source: BriefSource | undefined): RequestView {
  return {
    qlooCallId: request.qlooCallId,
    sourceNumber: source?.n ?? null,
    endpoint: request.endpoint,
    filterType: request.filterType,
    filterLabel: request.filterLabel,
    params: request.params,
    rows: request.rows,
    ms: request.ms,
    cache: request.cache,
    cacheLabel: request.cacheLabel,
    requestId: request.requestId,
    status: source?.status ?? null,
    error: source?.error ?? null,
    evidenceIds: source?.evidenceIds ?? [],
  };
}

export function sourceRequestView(source: BriefSource): RequestView {
  return {
    qlooCallId: source.qlooCallId,
    sourceNumber: source.n,
    endpoint: source.endpoint,
    filterType: source.filterType,
    filterLabel: source.filterLabel,
    params: source.params,
    rows: source.rows,
    ms: source.ms,
    cache: source.cache,
    cacheLabel: source.cacheLabel,
    requestId: source.requestId,
    status: source.status,
    error: source.error,
    evidenceIds: source.evidenceIds,
  };
}

const KIND_WORD: Readonly<Record<Footnote["kind"], string>> = { metric: "Number", evidence: "Evidence", figure: "Figure" };

function Label({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[10px] leading-[14px] font-semibold tracking-[1.1px] text-dim uppercase">{children}</p>;
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-[11px] leading-[17px] text-dim">{term}</dt>
      <dd className="m-0 min-w-0 text-[12px] leading-[17px] text-ink">{children}</dd>
    </>
  );
}

/** The evidence bundles a number or a request belongs to: "E2 · Triangular similarity scoring …". */
function EvidenceList({ ids }: { ids: readonly string[] }) {
  const { evidence } = useBrief();
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <Label>Evidence bundle{ids.length === 1 ? "" : "s"}</Label>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {ids.map((id) => {
          const e = evidence[id];
          return (
            <li key={id} className="text-[12px] leading-[17px] text-text-2" data-evidence-id={id}>
              <span className="font-mono text-[11px] text-ink">{id}</span>
              {e ? ` · ${e.purpose.trim().replace(/[.\s]+$/, "")}` : " · not streamed"}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The request's curl: from its full query when an evidence bundle recorded one (`full`), else from the
 * redacted parameters (`exact` false when those were shortened). Null without an endpoint.
 */
export function requestCurl(request: Pick<RequestView, "endpoint" | "params">, query: CallQuery | null | undefined): { command: string; exact: boolean } | null {
  if (query) return { command: curlCommand(query.path, Object.entries(query.query)), exact: true };
  if (!request.endpoint) return null;
  return { command: curlCommand(request.endpoint, request.params), exact: !hasShortenedParams(request.params) };
}

/** A parameter name that breaks only after its dots: "filter.results." over "entities", never mid-word. */
export function ParamName({ name }: { name: string }) {
  const parts = name.split(".");
  return parts.map((part, i) => (
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 ? (
        <>
          .<wbr />
        </>
      ) : null}
    </Fragment>
  ));
}

/** One request in full. Its stamp stays still here: it flashed where the call landed. */
export function RequestDetail({ request, showEvidence = true }: { request: RequestView; showEvidence?: boolean }) {
  const { queries } = useBrief();
  const params = publicParams(request.params);
  const curl = requestCurl(request, queries.get(request.qlooCallId));
  return (
    <section aria-label={`Qloo request${request.sourceNumber ? ` ${request.sourceNumber}` : ""}`} className="flex flex-col gap-3" data-request={request.qlooCallId}>
      <div className="flex items-center gap-2">
        <p className="m-0 min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
          GET {request.endpoint ?? "unknown endpoint"}
          {request.filterLabel ? <span className="text-dim"> · {request.filterLabel}</span> : null}
        </p>
        {request.cache ? <RequestStamp cache={request.cache} /> : null}
      </div>
      <dl className="m-0 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-0.5">
        <Row term="Filter type">{request.filterType ? <span className="font-mono text-[11px]">{request.filterType}</span> : "none"}</Row>
        <Row term="Rows">{request.rows ?? "no rows"}</Row>
        <Row term="Latency">{request.ms === null ? "not recorded" : request.cache === "miss" || request.ms > 0 ? formatDuration(request.ms) : "served from cache"}</Row>
        <Row term="Cache">{request.cacheLabel || "not recorded"}</Row>
        {request.status !== null ? <Row term="HTTP status">{request.status}</Row> : null}
        {request.error ? <Row term="Error">{request.error}</Row> : null}
        {request.sourceNumber !== null ? (
          <Row term="Source">
            <a href={`#source-${request.sourceNumber}`} className="text-accent hover:underline hover:underline-offset-2">
              Request {request.sourceNumber} in Sources
            </a>
          </Row>
        ) : null}
      </dl>
      <div className="flex flex-col gap-1">
        <Label>Parameters · redacted</Label>
        {params.length > 0 ? (
          <table className="w-full border-collapse font-mono text-[10.5px] leading-[15px]">
            <tbody>
              {params.map(([name, value]) => (
                <tr key={name} className="border-t border-line align-top">
                  <th scope="row" className="w-[42%] py-0.5 pr-2 text-left font-normal text-dim">
                    <ParamName name={name} />
                  </th>
                  <td className="py-0.5 text-ink [overflow-wrap:anywhere]">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="m-0 text-[12px] text-dim">No parameters recorded.</p>
        )}
        {hasShortenedParams(request.params) ? (
          <p className="m-0 text-[11px] leading-4 text-dim">
            {curl?.exact ? "Long values are shortened here; the curl carries them in full." : "Long values are shortened here, and so in the curl."}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <Label>Request id</Label>
        {request.requestId ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <code className="font-mono text-[11px] text-ink [overflow-wrap:anywhere]" data-request-id>
              {request.requestId}
            </code>
            <CopyButton text={request.requestId}>Copy id</CopyButton>
          </div>
        ) : (
          <p className="m-0 text-[12px] text-dim">No response arrived, so there is no request id.</p>
        )}
      </div>
      {showEvidence ? <EvidenceList ids={request.evidenceIds} /> : null}
      {curl ? (
        <div className="flex flex-col gap-1 border-t border-line pt-2" data-curl={curl.command} data-curl-exact={curl.exact}>
          <CopyButton text={curl.command}>Copy as curl</CopyButton>
          <p className="m-0 text-[11px] leading-4 text-dim">The key is your own: the command reads it from $QLOO_API_KEY.</p>
        </div>
      ) : null}
    </section>
  );
}

/** The value line of a metric: its text and comparator; "Not measured" with the reason, never 0. */
function MetricLine({ note }: { note: Footnote }) {
  const m = note.metric;
  if (!m) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <p className="m-0 text-[13px] leading-[18px] font-medium text-ink">{sentenceCase(m.label)}</p>
      {m.unavailable ? (
        <p className="m-0 text-[13px] leading-[18px] text-dim" data-unavailable="true">
          Not measured: {m.reasonLabel ?? "no value"}
        </p>
      ) : (
        <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-[13px] leading-[18px]">
          <span className="font-serif text-[18px] font-medium text-ink tabular-nums">{m.text}</span>
          {m.comparatorLabel ? <span className="text-dim">{m.comparatorLabel}</span> : null}
          {m.window ? <span className="text-dim">· {m.window} only</span> : null}
        </p>
      )}
    </div>
  );
}

/** Everything behind one footnote. `close` returns focus to the number that opened it. */
export function NoteInspector({ note, close }: { note: Footnote; close?: () => void }) {
  const { sources } = useBrief();
  const [selected, setSelected] = useState(0);
  const requests = note.requests;
  const current = requests[Math.min(selected, requests.length - 1)];
  const view = current ? requestViewOf(current, current.sourceIndex === null ? undefined : sources[current.sourceIndex]) : null;
  const badge = note.metric ? BADGE_LABEL[note.metric.badge] : null;
  return (
    <div className="flex flex-col gap-3" data-inspector={note.n}>
      <div className="flex items-start gap-3">
        <p className="m-0 flex-1 text-[10.5px] leading-[14px] font-semibold tracking-[1.3px] text-accent uppercase">
          Note {note.n} · {KIND_WORD[note.kind]}
          {badge ? <span className="text-dim"> · {badge}</span> : null}
        </p>
        {close ? (
          <button type="button" onClick={close} aria-label="Close" className="-mt-1 -mr-1 rounded-brief px-1 text-[16px] leading-none text-dim hover:text-ink">
            ×
          </button>
        ) : null}
      </div>
      {note.metric ? <MetricLine note={note} /> : null}
      <p className="m-0 type-sidenote text-text-2">{sentenceCase(note.text)}</p>
      {note.computed ? (
        <p className="m-0 text-[12px] leading-[17px] text-text-2" data-formula={note.computed.formulaId}>
          Computed in code by QUANT, not by a model. Formula{" "}
          {/* The formula's entry on /method once that page is built; until then its id, not a dead link. */}
          {ROUTE_LIVE.method ? (
            <a href={`/method#${encodeURIComponent(note.computed.formulaId)}`} className="font-mono text-[11px] text-accent hover:underline">
              {note.computed.formulaId}
            </a>
          ) : (
            <span className="font-mono text-[11px] text-ink">{note.computed.formulaId}</span>
          )}
        </p>
      ) : null}
      {note.unavailable && !note.metric ? (
        <p className="m-0 text-[12px] text-dim" data-unavailable="true">
          Not measured: {note.unavailable.label}
        </p>
      ) : null}
      <EvidenceList ids={note.evidenceIds} />
      {view ? (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          {requests.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Requests behind this note">
              <span className="mr-1 text-[11px] text-dim">
                Request {Math.min(selected, requests.length - 1) + 1} of {requests.length}
              </span>
              {requests.map((r, i) => (
                <button
                  key={r.qlooCallId}
                  type="button"
                  aria-pressed={i === selected}
                  aria-label={`Request ${i + 1}`}
                  onClick={() => setSelected(i)}
                  className={cx(
                    "h-5 min-w-5 rounded-brief border px-1 font-mono text-[10px]",
                    i === selected ? "border-accent bg-accent-soft text-accent" : "border-line text-dim hover:text-ink",
                  )}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          ) : null}
          <RequestDetail request={view} showEvidence={false} />
        </div>
      ) : (
        <p className="m-0 border-t border-line pt-3 text-[12px] text-dim">No Qloo request stands behind this number.</p>
      )}
    </div>
  );
}

/** A Sources row's inspector: one request and the bundles it fed. */
export function SourceInspector({ source, close }: { source: BriefSource; close?: () => void }) {
  return (
    <div className="flex flex-col gap-3" data-inspector={`source-${source.n}`}>
      <div className="flex items-start gap-3">
        <p className="m-0 flex-1 text-[10.5px] leading-[14px] font-semibold tracking-[1.3px] text-accent uppercase">
          Request {source.n}
          {source.refs.length > 0 ? <span className="text-dim normal-case tracking-normal font-normal"> · {source.refs.join(", ")}</span> : null}
        </p>
        {close ? (
          <button type="button" onClick={close} aria-label="Close" className="-mt-1 -mr-1 rounded-brief px-1 text-[16px] leading-none text-dim hover:text-ink">
            ×
          </button>
        ) : null}
      </div>
      <RequestDetail request={sourceRequestView(source)} />
    </div>
  );
}
