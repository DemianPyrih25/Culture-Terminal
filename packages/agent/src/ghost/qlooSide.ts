import {
  GhostPickCategory,
  type DatasetEnvelope,
  type DatasetId,
  type DatasetOf,
  type EntityRef,
  type EntityRegistry,
  type MarketId,
  type ReportExhibit,
} from "@ct/contracts";
import { normaliseName } from "@ct/quant";
import type { GazetteerLike } from "./places";

/**
 * The Qloo side of the GHOST diff (SPEC §6.6): per pick category, the names the finished brief
 * actually ranks, best first. Only the datasets the Report shows count, in its exhibit order, so the
 * diff compares GHOST with what the reader sees. Datasets are told apart by kind, payload and formula
 * ids, as the skills write them (packages/quant/src/skills):
 *
 * | category | source (skill) | order |
 * |---|---|---|
 * | competitors | Substitution Map, Matrix "similarity" (peer_landscape) | the target's row by similarity, target left out, unscored left out |
 * | markets | Share of Taste, Matrix "share" METRO rows (share_of_taste) | the subject's within-call percentile per market |
 * | markets, when no share grid ranks one | Travel taste, Quadrant "trvl.quadrant" (destination_affinity) | FIT |
 * | neighbourhoods | Lift Map, GeoLift (geo_lift) | lift; none from a coarse map, which makes no neighbourhood claims |
 * | neighbourhoods | Block DNA, Bars "block.rank_delta" (block_dna) | the studied area, after the lift ranking |
 * | tenants | Tenant fit, Slope "tenant.fit" (rank_candidates site vs city) | TenantFit score |
 * | tenants | a one-context rank at a site, Ranked "site:" group (rank_candidates) | rank |
 * | tenants | Local brands, Ranked "block.rank_delta" (block_dna) | rank gain vs the city |
 * | partners | Sponsor slate, Slate (sponsor_slate) | best fits by FIT, then runners-up by FIT |
 * | partners | Cultural neighbourhood, Ranked "xdom.under_the_radar" brand group (cross_domain) | rank |
 * | partners | Concept vector, Ranked KEEP and ADD rows, never VETO (concept_vector) | rank |
 * | partners | a one-scale ranking from a signal, Ranked "none" group (rank_candidates) | rank |
 * | neighbourhoods | Taste Twins, Ranked rows that name an area of a map city (taste_twins) | rank (rho) |
 * | creators | Cultural neighbourhood, Ranked "xdom.under_the_radar" person, artist and podcast groups (cross_domain) | rank |
 *
 * Within a category the sources follow that order, a name already listed is skipped, and the list
 * stops at GHOST_QLOO_SIDE_MAX. The brief's subject (subjectOf) is never one of its own picks,
 * though a second map may rank it.
 */

/** The Qloo-side names per category the diff lists: GHOST's picks are matched against all of them. */
export const GHOST_QLOO_SIDE_MAX = 10;

export interface QlooSideItem {
  name: string;
  ref: EntityRef | null;
  /** A market the share grid ranked. */
  market: MarketId | null;
  /** A gazetteer neighbourhood, "<metro>:<id>". */
  area: string | null;
  /** Qloo popularity (0–1) from the payload, else the registry; null when unknown (markets, areas). */
  popularity: number | null;
  datasetId: DatasetId;
}

export type QlooSide = Record<GhostPickCategory, QlooSideItem[]>;

export interface QlooSideInput {
  /** The Report's exhibits, in order (only their dataset ids are read). */
  exhibits: readonly Pick<ReportExhibit, "datasetId">[];
  /** The run's datasets; any the Report does not show are ignored. */
  datasets: readonly DatasetEnvelope[];
  /** The categories to fill (GHOST_JOB_CATEGORIES of the report's job); the rest stay empty. */
  categories: readonly GhostPickCategory[];
  registry?: Pick<EntityRegistry, "entity">;
  /** Names a Block DNA area's metro; without it the area is matched by name only. */
  geo?: GazetteerLike;
}

type Draft = Omit<QlooSideItem, "datasetId" | "popularity"> & { popularity?: number | null };
type Extractor = (d: DatasetEnvelope, input: QlooSideInput) => Draft[];

const item = (name: string, ref: EntityRef | null, popularity: number | null = null): Draft => ({ name, ref, market: null, area: null, popularity });
const byDesc = <T>(score: (t: T) => number | null) => (a: T, b: T) => (score(b) ?? -Infinity) - (score(a) ?? -Infinity);
const isKind = <K extends DatasetEnvelope["kind"]>(d: DatasetEnvelope, kind: K): d is DatasetOf<K> => d.kind === kind;

/** The target's row of a Substitution Map: its peers by symmetric similarity, highest first. */
const substitutes: Extractor = (d) => {
  if (!isKind(d, "Matrix") || d.payload.mode !== "similarity") return [];
  const { rows, cols, cells, targetKey } = d.payload;
  const row = cells[rows.findIndex((r) => r.key === targetKey)];
  if (targetKey === null || row === undefined) return [];
  return cols
    .map((col, j) => ({ col, value: row[j]?.value ?? null }))
    .filter(({ col, value }) => col.key !== targetKey && value !== null)
    .sort(byDesc((c) => c.value))
    .map(({ col }) => item(col.label, col.ref));
};

const METRO_ROW = "metro:";

/** A Share of Taste grid's markets by the subject's within-call percentile, highest first. */
const shareMarkets: Extractor = (d) => {
  if (!isKind(d, "Matrix") || d.payload.mode !== "share") return [];
  const { rows, cols, cells, targetKey } = d.payload;
  const j = cols.findIndex((c) => c.key === targetKey);
  if (targetKey === null || j < 0) return [];
  return rows
    .map((row, i) => ({ row, value: cells[i]?.[j]?.value ?? null }))
    .filter(({ row, value }) => row.group === "METRO" && row.key.startsWith(METRO_ROW) && value !== null)
    .sort(byDesc((r) => r.value))
    .map(({ row }) => ({ ...item(row.label, null), market: row.key.slice(METRO_ROW.length) }));
};

/** Travel-taste destinations by FIT: the markets fallback for a run whose markets were not shareable (director.md §6). */
const travelMarkets: Extractor = (d) => {
  if (!isKind(d, "Quadrant") || !d.formulaIds.includes("trvl.quadrant")) return [];
  return [...d.payload.points].sort(byDesc((p) => p.y)).map((p) => item(p.label, p.ref, p.x));
};

const liftNeighbourhoods: Extractor = (d) => {
  if (!isKind(d, "GeoLift") || d.payload.coarse) return [];
  const { metro } = d.payload;
  return d.payload.neighbourhoods
    .filter((n) => n.lift !== null)
    .sort(byDesc((n) => n.lift))
    .map((n) => ({ ...item(n.name, null), area: `${metro}:${n.id}` }));
};

/** The area a Block DNA compares with its city; a point is not a neighbourhood GHOST could name. */
const blockArea: Extractor = (d, input) => {
  if (!isKind(d, "Bars") || d.payload.method === null || !d.formulaIds.includes("block.rank_delta")) return [];
  const area = d.payload.series[0];
  if (area === undefined || area.key === "point") return [];
  const geo = input.geo;
  const metro = geo === undefined ? undefined : geo.metros().find((m) => geo.neighbourhood(m, area.key) !== null);
  return [{ ...item(area.label, null), area: metro === undefined ? null : `${metro}:${area.key}` }];
};

const tenantFit: Extractor = (d) => {
  if (!isKind(d, "Slope") || !d.formulaIds.includes("tenant.fit")) return [];
  return d.payload.lines
    .filter((l) => l.score !== null)
    .sort(byDesc((l) => l.score))
    .map((l) => item(l.label, l.ref));
};

/** Rows of a Ranked group in rank order, unranked rows left out. */
function rankedRows(group: { rows: DatasetOf<"Ranked">["payload"]["groups"][number]["rows"] }, popularityAt: number): Draft[] {
  return group.rows
    .filter((r) => r.rank !== null)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((r) => item(r.label, r.ref, popularityAt < 0 ? null : (r.cells[popularityAt]?.value ?? null)));
}

const popularityColumn = (d: DatasetOf<"Ranked">) => d.payload.columns.findIndex((c) => c.key === "popularity");

const siteRank: Extractor = (d) => {
  if (!isKind(d, "Ranked") || d.formulaIds.includes("block.rank_delta") || d.formulaIds.includes("xdom.under_the_radar")) return [];
  return d.payload.groups.filter((g) => g.key.startsWith("site:")).flatMap((g) => rankedRows(g, popularityColumn(d)));
};

const localBrands: Extractor = (d) => {
  if (!isKind(d, "Ranked") || !d.formulaIds.includes("block.rank_delta")) return [];
  return d.payload.groups.flatMap((g) => rankedRows(g, popularityColumn(d)));
};

/** Best fit per category, then the runners-up, each by FIT: one scoring call puts the whole slate on one scale. */
const slate: Extractor = (d) => {
  if (!isKind(d, "Slate")) return [];
  const entries = (pick: "best" | "runnerUp") =>
    d.payload.rows
      .flatMap((r) => {
        const entry = r[pick];
        return entry === null ? [] : [entry];
      })
      .sort(byDesc((e) => e.fit.value))
      .map((e) => item(e.label, e.ref, e.popularity));
  return [...entries("best"), ...entries("runnerUp")];
};

const crossDomainBrands: Extractor = (d) => {
  if (!isKind(d, "Ranked") || !d.formulaIds.includes("xdom.under_the_radar")) return [];
  return d.payload.groups.filter((g) => g.key === "brand").flatMap((g) => rankedRows(g, popularityColumn(d)));
};

/** The cross_domain domains a creator comes from (creator_fit): public figures, artists and podcasts. */
const CREATOR_GROUPS: ReadonlySet<string> = new Set(["person", "artist", "podcast"]);

const crossDomainCreators: Extractor = (d) => {
  if (!isKind(d, "Ranked") || !d.formulaIds.includes("xdom.under_the_radar")) return [];
  return d.payload.groups.filter((g) => CREATOR_GROUPS.has(g.key)).flatMap((g) => rankedRows(g, popularityColumn(d)));
};

/**
 * A concept vector's kept analogs and added open-call results, in rank order. A VETO row is the
 * concept's taste pointing elsewhere: never a pick, so it never counts as one the brief makes.
 */
const conceptPartners: Extractor = (d) => {
  if (!isKind(d, "Ranked") || !d.payload.groups.some((g) => g.rows.some((r) => r.flags.some((f) => f === "KEEP" || f === "VETO" || f === "ADD")))) {
    return [];
  }
  const at = popularityColumn(d);
  return d.payload.groups.flatMap((g) => rankedRows({ rows: g.rows.filter((r) => r.flags.includes("KEEP") || r.flags.includes("ADD")) }, at));
};

/** A one-scale ranking from a signal (rank_candidates under a "none" context): brand_collab's partner scoring. */
const signalRank: Extractor = (d) => {
  if (!isKind(d, "Ranked") || d.formulaIds.includes("block.rank_delta") || d.formulaIds.includes("xdom.under_the_radar")) return [];
  return d.payload.groups.filter((g) => g.key === "none").flatMap((g) => rankedRows(g, popularityColumn(d)));
};

/**
 * The areas a Taste Twins ranking names, best twin first: Ranked rows that are no entity or tag and
 * whose key or label is an area of a map city (no other Ranked dataset ranks areas). A row the
 * gazetteer cannot place is left out, so only areas GHOST could name count.
 */
const twinAreas: Extractor = (d, input) => {
  const geo = input.geo;
  if (!isKind(d, "Ranked") || geo === undefined) return [];
  const placed = (row: DatasetOf<"Ranked">["payload"]["groups"][number]["rows"][number]): string | null => {
    for (const metro of geo.metros()) {
      if (geo.neighbourhood(metro, row.key) !== null) return `${metro}:${row.key}`;
      const named = geo.matchNeighbourhood(metro, row.label);
      if (named !== null) return `${metro}:${named.id}`;
    }
    return null;
  };
  return d.payload.groups.flatMap((g) =>
    g.rows
      .filter((r) => r.rank !== null && r.ref === null && r.tagRef === null && !r.flags.includes("TARGET"))
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
      .flatMap((r) => {
        const area = placed(r);
        return area === null ? [] : [{ ...item(r.label, null), area }];
      }),
  );
};

/**
 * Per category, groups of sources: the first group with any name is used alone (the travel-taste
 * fallback); within a group, every source contributes in order.
 */
const SOURCES: Readonly<Record<GhostPickCategory, readonly (readonly Extractor[])[]>> = {
  competitors: [[substitutes]],
  markets: [[shareMarkets], [travelMarkets]],
  neighbourhoods: [[twinAreas], [liftNeighbourhoods, blockArea]],
  tenants: [[tenantFit, siteRank, localBrands]],
  partners: [[slate, conceptPartners, signalRank, crossDomainBrands]],
  creators: [[crossDomainCreators]],
};

/** Already listed: the same ref, market or area, or (when either has none) the same name. */
function listed(items: readonly QlooSideItem[], d: Draft): boolean {
  return items.some((i) => {
    for (const key of ["ref", "market", "area"] as const) {
      if (i[key] !== null && d[key] !== null) return i[key] === d[key];
    }
    return normaliseName(i.name) === normaliseName(d.name);
  });
}

/**
 * The ref the brief is about: the Taste Position card's subject (investment desk), else the first
 * Matrix's target (SUBS and SHARE key their axes by ref) or the first slate's seed.
 */
function subjectOf(shown: readonly DatasetEnvelope[]): string | null {
  const position = shown.find((d): d is DatasetOf<"Position"> => isKind(d, "Position"));
  if (position !== undefined) return position.payload.subject.ref;
  for (const d of shown) {
    if (isKind(d, "Matrix") && d.payload.targetKey !== null) return d.payload.targetKey;
    if (isKind(d, "Slate")) return d.payload.seed.ref;
  }
  return null;
}

export function qlooSide(input: QlooSideInput): QlooSide {
  const byId = new Map(input.datasets.map((d) => [d.id, d]));
  const shown = [...new Set(input.exhibits.map((e) => e.datasetId))].flatMap((id) => byId.get(id) ?? []);
  const subject = subjectOf(shown);
  const side = Object.fromEntries(GhostPickCategory.options.map((c) => [c, [] as QlooSideItem[]])) as QlooSide;
  for (const category of new Set(input.categories)) {
    for (const group of SOURCES[category]) {
      const items: QlooSideItem[] = [];
      for (const extract of group) {
        for (const d of shown) {
          for (const draft of extract(d, input)) {
            if (items.length >= GHOST_QLOO_SIDE_MAX || (draft.ref !== null && draft.ref === subject) || listed(items, draft)) continue;
            const popularity = draft.popularity ?? (draft.ref === null ? null : (input.registry?.entity(draft.ref)?.popularity ?? null));
            items.push({ ...draft, popularity, datasetId: d.id });
          }
        }
      }
      if (items.length > 0) {
        side[category] = items;
        break;
      }
    }
  }
  return side;
}
