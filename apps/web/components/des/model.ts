import type { Badge, CacheStatus, DatasetEnvelope, QlooPath } from "@ct/contracts";
import type { DesType } from "./des-href";

/**
 * What a tearsheet page shows (server/des builds it): plain data with no Qloo entity id, request
 * parameter or provenance query in it, so nothing the reader should not see can reach the browser.
 */

/** A figure's source line, linked to the request in Receipts. */
export interface DesSource {
  /** "Source: Qloo /v2/insights · 1 request · computed in code". */
  text: string;
  /** The first request behind it; null when no request answered. */
  requestId: string | null;
  /** Its number in Receipts; null when it is not listed. */
  receipt: number | null;
}

/** One figure: its dataset, drawn by its family (or as tag chips), with its source. */
export interface DesFigure {
  /** The dataset id (D#), or D#:<group> for one list of a grouped dataset. */
  key: string;
  title: string;
  caption: string | null;
  dataset: DatasetEnvelope;
  source: DesSource;
  /** Facet tags draw as chips by family: their peer column has nothing to count on a lone entity. */
  display: "exhibit" | "tags";
  /** Points the figure's title names, ringed and labelled first (the top destination of travel taste). */
  featured?: string[];
}

export type DesSectionStatus = "ok" | "partial" | "empty" | "failed";

export interface DesSection {
  status: DesSectionStatus;
  figures: DesFigure[];
  /** The skill's fixed method limitations and the sentences of the flags it raised. */
  notes: string[];
  /** Why nothing (or not everything) shows, in a sentence; null when everything does. */
  gap: string | null;
}

/** A key figure of the overview: one ledger metric, printed as the ledger formats it. */
export interface DesKeyFigure {
  key: string;
  /** "Popularity". */
  label: string;
  /** The metric's display ("0.78", "+0.59"), a name ("Elk Lake"), or "not measured" when UNAVAILABLE. */
  value: string;
  /** A number, or a name (which may run to two words or more). */
  kind: "number" | "name";
  /** What it is measured against, e.g. "Qloo percentile, all brands". */
  detail: string;
  badge: Badge;
  /** The request behind it in Receipts. */
  receipt: number | null;
}

/** One Qloo request, as Receipts lists it. */
export interface DesReceipt {
  n: number;
  endpoint: QlooPath;
  /** "demographics", "artist"; null for endpoints without a filter type. */
  filterLabel: string | null;
  /** What the request was for, from its evidence: "Cultural neighbourhood in podcasts". */
  purpose: string | null;
  cache: CacheStatus;
  /** "cached 2h" or "live"; the age of a cached answer. */
  cacheLabel: string;
  rows: number | null;
  ms: number;
  requestId: string | null;
  error: string | null;
}

export type DesSectionId = "dna" | "neighbours" | "travel";

export interface Tearsheet {
  /** What was asked. */
  query: { name: string; type: DesType };
  /** The entity it resolved to, as Qloo names it. */
  entity: { name: string; type: DesType; disambiguation: string | null };
  /** The reader chose the entity from Qloo's candidates (a picker or the closest names); false for an exact match. */
  picked: boolean;
  /** "JUNIPER COLA <BRAND> DES". */
  mnemonic: string;
  /** When it was computed (ISO). */
  computedAt: string;
  keyFigures: DesKeyFigure[];
  sections: Record<DesSectionId, DesSection>;
  receipts: DesReceipt[];
  /** Ledger numbers that trace to a request, of all the numbers on the page. */
  traced: { traced: number; total: number };
  /** Qloo requests in all, and those served from the cache. */
  requests: { total: number; cached: number };
}

/** A candidate of the picker: an opaque key, never the Qloo entity id (D20). */
export interface DesCandidate {
  key: string;
  name: string;
  disambiguation: string | null;
  /** Shown to tell candidates apart; never used to choose (D20). */
  popularity: number | null;
  /** The tearsheet with this candidate picked. */
  href: string;
}

/** Why live tearsheets are off: the mode machine, Qloo switched off or not configured, or a budget. */
export type DesUnavailableCause = "paused" | "qloo_off" | "unconfigured" | "budget";

/** What the tearsheet page renders for a request. */
export type DesOutcome =
  | {
      kind: "ready";
      sheet: Tearsheet;
      /** Served from the tearsheet answer cache: when it was computed. Null when computed for this request. */
      cachedAt: string | null;
    }
  /** The name matches several entities of the type exactly: the reader picks (D20). */
  | { kind: "pick"; query: { name: string; type: DesType }; message: string; candidates: DesCandidate[] }
  /** No exact match: the closest candidates are offered, never applied. */
  | { kind: "not_found"; query: { name: string; type: DesType }; message: string; candidates: DesCandidate[] }
  /** A person who is not a vetted public figure (CLERK's rule at $0), refused before any Qloo request. */
  | { kind: "refused"; query: { name: string; type: DesType }; message: string }
  | { kind: "unavailable"; cause: DesUnavailableCause; message: string; until: string | null }
  | { kind: "limited"; message: string; retryAfterS: number }
  | { kind: "failed"; message: string };
