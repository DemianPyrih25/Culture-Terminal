// A synthetic brand world for peer_landscape: invented entities, a symmetric similarity table and the
// discovery lists Qloo would return. The fake insights handler answers matrix calls from the table,
// so a test reads like a description of the market it sets up.
import type { QlooEntity, QlooParams, QlooParamValue } from "@ct/contracts";
import { CAT_BEVERAGE, CAT_SNACK, insightEntity, type Invented } from "./fakes";

export const ALPHA: Invented = { id: "ent-alpha-01", name: "Brand Alpha", category: CAT_BEVERAGE, popularity: 0.9 };
export const BETA: Invented = { id: "ent-beta-02", name: "Brand Beta", category: CAT_BEVERAGE };
export const GAMMA: Invented = { id: "ent-gamma-03", name: "Brand Gamma", category: CAT_BEVERAGE };
export const DELTA: Invented = { id: "ent-delta-04", name: "Brand Delta", category: CAT_BEVERAGE };
export const EPSILON: Invented = { id: "ent-epsilon-05", name: "Brand Epsilon", category: CAT_BEVERAGE };
export const JUNK: Invented = { id: "ent-junk-06", name: "Brand Junk", category: CAT_BEVERAGE, popularity: 0.004 };
export const OMEGA: Invented = { id: "ent-omega-07", name: "Snack Omega", category: CAT_SNACK };
export const ZETA: Invented = { id: "ent-zeta-08", name: "Brand Zeta", category: CAT_BEVERAGE };
export const ARTIST_NOVA: Invented = { id: "ent-nova-09", name: "Artist Nova", category: null };
export const UNTAGGED: Invented = { id: "ent-plain-10", name: "Brand Plain", category: null };

const ALL = [ALPHA, BETA, GAMMA, DELTA, EPSILON, JUNK, OMEGA, ZETA, ARTIST_NOVA, UNTAGGED];

export function simKey(a: Invented, b: Invented): string {
  return [a.id, b.id].sort().join("|");
}

export function sims(entries: [Invented, Invented, number][]): Record<string, number> {
  return Object.fromEntries(entries.map(([a, b, s]) => [simKey(a, b), s]));
}

export interface World {
  sims: Record<string, number>;
  /** D1 results in order (same category). */
  sameCategory: Invented[];
  /** D2 results in order (cross-category). */
  crossCategory: Invented[];
  /** Signal entity id → candidate ids its scoring response omits. */
  drops?: Record<string, string[]>;
}

function list(v: QlooParamValue | undefined): string[] {
  if (typeof v === "string") return [v];
  return typeof v === "object" ? [...v] : [];
}

function byId(id: string): Invented {
  const e = ALL.find((x) => x.id === id);
  if (e === undefined) throw new Error(`unknown synthetic entity ${id}`);
  return e;
}

function score(world: World, a: Invented, b: Invented): number | undefined {
  return world.sims[simKey(a, b)];
}

/** Answers discovery calls from the lists and scoring calls from the similarity table. */
export function worldInsights(world: World): (params: QlooParams) => QlooEntity[] {
  return (params) => {
    const signal = byId(list(params["signal.interests.entities"])[0] ?? "");
    const candidates = params["filter.results.entities"];
    if (candidates !== undefined) {
      const dropped = world.drops?.[signal.id] ?? [];
      return list(candidates)
        .filter((id) => !dropped.includes(id))
        .map((id) => insightEntity(byId(id), score(world, signal, byId(id))));
    }
    const pool = params["filter.tags"] !== undefined ? world.sameCategory : world.crossCategory;
    return pool.map((e) => insightEntity(e, score(world, signal, e)));
  };
}

/**
 * The reference market: Brand Alpha sits apart from its category (last in every peer row), Brand
 * Beta and Brand Gamma are each other's closest match, and Snack Omega from another category is
 * Alpha's nearest neighbour. Brand Junk is a popularity artifact in the D1 list.
 */
export const ISLAND_WORLD: World = {
  sims: sims([
    [ALPHA, BETA, 0.2],
    [ALPHA, GAMMA, 0.22],
    [ALPHA, DELTA, 0.18],
    [ALPHA, EPSILON, 0.15],
    [ALPHA, JUNK, 0.25],
    [ALPHA, OMEGA, 0.3],
    [BETA, GAMMA, 0.9],
    [BETA, DELTA, 0.6],
    [BETA, OMEGA, 0.5],
    [GAMMA, DELTA, 0.55],
    [GAMMA, OMEGA, 0.45],
    [DELTA, OMEGA, 0.4],
  ]),
  sameCategory: [BETA, JUNK, GAMMA, DELTA, EPSILON],
  crossCategory: [OMEGA, BETA, GAMMA],
};
