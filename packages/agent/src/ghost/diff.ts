import {
  GHOST_HONESTY_LINE,
  GhostDiff,
  GhostPickCategory,
  type DatasetEnvelope,
  type EntityRef,
  type EntityRegistry,
  type GhostAnswer,
  type Report,
  type ReportExhibit,
} from "@ct/contracts";
import { normaliseName } from "@ct/quant";
import { gazetteer } from "../run/gazetteer";
import { GHOST_JOB_CATEGORIES } from "./categories";
import type { GazetteerLike } from "./places";
import { qlooSide, type QlooSideItem } from "./qlooSide";
import type { ResolvedGhostPick } from "./resolve";

/**
 * The GHOST diff (SPEC §6.6): GHOST's picks against the names the brief ranks (qlooSide), per
 * category, with the header figures. Every definition lives here.
 *
 * Matching: a pick and a Qloo-side name are the same thing when they share a ref, else a Qloo entity
 * id (through the registry), else a market, else a gazetteer area; when they have no such id in
 * common (one side has none, or they hold different kinds), when their names are equal under
 * normaliseName (GHOST's own spelling or the name its lookup matched). Two refs, entity ids, markets
 * or areas that differ never match by name. A market or neighbourhood pick matches by market, area
 * or name only: the locality its search found and a destination the brief ranks are different Qloo
 * entities for the same city. Each name matches at most once, GHOST's picks taking the first
 * unmatched Qloo-side name in rank order.
 *
 * Statuses: both (✓) is a pick that matches a Qloo-side name; the item carries Qloo's spelling and
 * ref. qloo_only (★) is a Qloo-side name no pick matches. llm_only (✗) is a pick that matches none;
 * resolvesInQloo is whether it resolves, or null when it was never checked.
 *
 * A pick is checked when its lookup ran (catalogue, gazetteer or search) or it matched a Qloo-side
 * name; it resolves when that lookup found it exactly, or it matched one. A gazetteer neighbourhood
 * resolves: the brief measures areas by its polygons. A catalogue market resolves: it is a pinned
 * Qloo locality.
 *
 * Header:
 * - overlapAt5: per category with at least one pick and one Qloo-side name, the matches whose two
 *   ranks are both within GHOST_OVERLAP_K, over GHOST_OVERLAP_K (|GHOST top 5 ∩ Qloo top 5| / 5),
 *   averaged over those categories; null when there is none.
 * - resolvability: picks that resolve over picks checked; null when none was checked.
 * - unsourcedNumericClaims: numeric_claims.length. No number GHOST states has a request behind it.
 * - meanPopularity: Qloo popularity (0–1). ghost: over its picks that resolve with a known popularity
 *   (the lookup's, else the matched Qloo-side name's). qloo: over each category's top
 *   GHOST_OVERLAP_K Qloo-side names with one. Null when no value is known.
 * - honestyLine: GHOST_HONESTY_LINE, always.
 */

export const GHOST_OVERLAP_K = 5;

export interface GhostDiffInput {
  answer: GhostAnswer;
  /** resolveGhostPicks for this answer; a pick missing here counts as never checked. */
  resolved: readonly ResolvedGhostPick[];
  /** The finished brief: its job picks the categories, its exhibits the datasets. */
  report: Pick<Report, "job"> & { exhibits: readonly Pick<ReportExhibit, "datasetId">[] };
  /** The run's datasets (the ledger's, or RunState.datasets' data). */
  datasets: readonly DatasetEnvelope[];
  /** Refs to entity ids for matching, and popularity for Qloo-side names whose payload has none. */
  registry?: Pick<EntityRegistry, "entity" | "byEntityId">;
  /** Defaults to the shared gazetteer. */
  geo?: GazetteerLike;
}

/** What two names are matched on. */
interface Identity {
  ref: EntityRef | null;
  entityId: string | null;
  market: string | null;
  area: string | null;
  names: ReadonlySet<string>;
}

const IDS = ["ref", "entityId", "market", "area"] as const;

function sameThing(a: Identity, b: Identity): boolean {
  for (const key of IDS) {
    const x = a[key];
    const y = b[key];
    if (x !== null && y !== null) return x === y;
  }
  for (const n of a.names) if (b.names.has(n)) return true;
  return false;
}

const keys = (...names: (string | null)[]): Set<string> =>
  new Set(names.flatMap((n) => (n === null ? [] : [normaliseName(n)])).filter((k) => k !== ""));

interface PickEntry {
  name: string;
  rank: number;
  resolved: ResolvedGhostPick | null;
  identity: Identity;
}

interface SideEntry {
  item: QlooSideItem;
  rank: number;
  identity: Identity;
}

const mean = (values: readonly (number | null)[]): number | null => {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0) / known.length;
};

export function buildGhostDiff(input: GhostDiffInput): GhostDiff {
  const { answer, registry } = input;
  const side = qlooSide({
    exhibits: input.report.exhibits,
    datasets: input.datasets,
    categories: GHOST_JOB_CATEGORIES[input.report.job],
    registry,
    geo: input.geo ?? gazetteer(),
  });

  const items: GhostDiff["items"] = [];
  const overlaps: number[] = [];
  let checked = 0;
  let resolving = 0;
  const ghostPopularity: (number | null)[] = [];
  const qlooPopularity: (number | null)[] = [];

  for (const category of GhostPickCategory.options) {
    const isPlace = category === "markets" || category === "neighbourhoods";
    const picks: PickEntry[] = answer.picks[category].map((name, i) => {
      const r = input.resolved.find((p) => p.category === category && p.name === name) ?? null;
      const entityId = isPlace ? null : (r?.entityId ?? null);
      const area = r?.area ?? null;
      return {
        name,
        rank: i + 1,
        resolved: r,
        identity: {
          ref: isPlace ? null : (r?.ref ?? (entityId === null ? null : (registry?.byEntityId(entityId)?.ref ?? null))),
          entityId,
          market: r?.market ?? null,
          area: area === null ? null : `${area.metro}:${area.id}`,
          names: keys(name, r?.matchedName ?? null),
        },
      };
    });
    const qloo: SideEntry[] = side[category].map((item, i) => ({
      item,
      rank: i + 1,
      identity: {
        ref: item.ref,
        entityId: item.ref === null ? null : (registry?.entity(item.ref)?.entityId ?? null),
        market: item.market,
        area: item.area,
        names: keys(item.name),
      },
    }));

    const matchOf = new Map<PickEntry, SideEntry>();
    const taken = new Set<SideEntry>();
    for (const pick of picks) {
      const hit = qloo.find((q) => !taken.has(q) && sameThing(pick.identity, q.identity));
      if (hit === undefined) continue;
      matchOf.set(pick, hit);
      taken.add(hit);
    }

    for (const q of qloo) {
      const both = taken.has(q);
      items.push({ name: q.item.name, category, status: both ? "both" : "qloo_only", resolvesInQloo: null, ref: q.item.ref });
      if (q.rank <= GHOST_OVERLAP_K) qlooPopularity.push(q.item.popularity);
    }
    for (const pick of picks) {
      const hit = matchOf.get(pick);
      const looked = pick.resolved !== null && pick.resolved.lookup !== "skipped" && pick.resolved.lookup !== "failed";
      const isChecked = hit !== undefined || looked;
      const resolves = hit !== undefined || (looked && pick.resolved?.exact === true);
      if (isChecked) checked += 1;
      if (resolves) {
        resolving += 1;
        ghostPopularity.push(pick.resolved?.popularity ?? hit?.item.popularity ?? null);
      }
      if (hit === undefined) {
        items.push({ name: pick.name, category, status: "llm_only", resolvesInQloo: isChecked ? resolves : null, ref: pick.identity.ref });
      }
    }

    if (picks.length > 0 && qloo.length > 0) {
      const top = [...matchOf].filter(([pick, q]) => pick.rank <= GHOST_OVERLAP_K && q.rank <= GHOST_OVERLAP_K).length;
      overlaps.push(top / GHOST_OVERLAP_K);
    }
  }

  return GhostDiff.parse({
    items,
    overlapAt5: mean(overlaps),
    resolvability: checked === 0 ? null : resolving / checked,
    unsourcedNumericClaims: answer.numeric_claims.length,
    meanPopularity: { ghost: mean(ghostPopularity), qloo: mean(qlooPopularity) },
    honestyLine: GHOST_HONESTY_LINE,
  });
}
