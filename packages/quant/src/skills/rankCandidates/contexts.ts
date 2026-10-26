import {
  AGE_BUCKET_LABEL,
  AgeBucket,
  METRO_LABEL,
  MetroId,
  type AreaArg,
  type AudienceKey,
  type EstimateEnv,
  type LocalityApi,
  type MarketId,
  type MarketLocality,
  type NoValueReason,
  type QlooParams,
  type RankContext,
  type SkillCtx,
} from "@ct/contracts";
import { safeName } from "../format";
import { marketLabel } from "../metros";

/**
 * Scoring contexts for rank_candidates (RANK) and share_of_taste (SHARE): each context is one signal
 * that, with the candidate list, makes one /v2/insights rank call (SPEC §5.3 S2, S8). Locations use
 * the forms the probe verified: a metro's locality id (G2, never `.query`, so a deliberately pinned
 * locality cannot be swapped for a namesake), a gazetteer POLYGON or a POINT (G2, P5), never a radius.
 */

export type ContextKind = RankContext["kind"];

/** Grid sections; SHARE shows AGE, AUDIENCE and METRO, RANK any of them. */
export type ContextGroup = "AGE" | "AUDIENCE" | "METRO" | "CITY" | "SITE" | "SIGNAL";

/**
 * What building a context needs beyond its input: the run's pinned market localities and the
 * gazetteer. A null locality seam leaves metro and city contexts uncallable; a null gazetteer (an
 * estimate without one) leaves neighbourhood sites unbuilt.
 */
export type ContextEnv = EstimateEnv;

export function contextEnvOf(ctx: SkillCtx): ContextEnv {
  return { localities: ctx.localities, geo: ctx.geo };
}

/** The optional fourth estimateCalls argument; without it, metro, city and neighbourhood contexts count as one call. */
export function estimateEnvOf(env: EstimateEnv | undefined): ContextEnv {
  return env ?? { localities: null, geo: null };
}

/** One scoring context, ready to call or explained as not callable. */
export interface ContextSpec {
  /** Unique within one skill call, e.g. "age:55_and_older" or "metro:austin". */
  key: string;
  kind: ContextKind;
  group: ContextGroup;
  label: string;
  /** What metrics name besides the entity: the age bucket, audience URN, market, metro or area id; null for none. */
  subject: string | null;
  /** The signal parameters the context adds to the rank call; null when it cannot be called. */
  signal: QlooParams | null;
  /** Why the context is not called, with the notice the model reads; null when callable. */
  gap: { reason: NoValueReason; notice: string } | null;
  /** True when only a missing seam (localities or geo) kept the signal from being built; estimates count it as a call. */
  pending: boolean;
  /** The gazetteer metro of a metro, city or site context, else null. */
  metro: MetroId | null;
}

function callable(spec: Omit<ContextSpec, "signal" | "gap" | "pending">, signal: QlooParams): ContextSpec {
  return { ...spec, signal, gap: null, pending: false };
}

function notCallable(
  spec: Omit<ContextSpec, "signal" | "gap" | "pending">,
  reason: NoValueReason,
  notice: string,
  pending: boolean,
): ContextSpec {
  return { ...spec, signal: null, gap: { reason, notice }, pending };
}

function gazetteerMetro(market: MarketId): MetroId | null {
  const parsed = MetroId.safeParse(market);
  return parsed.success ? parsed.data : null;
}

/** "leisure: live music" from urn:audience:leisure:live_music; the URN is public taxonomy (D29). */
export function audienceLabel(audience: AudienceKey): string {
  const [, , family = "", ...leaf] = audience.split(":");
  const words = (s: string) => s.replace(/_/g, " ");
  return safeName(leaf.length > 0 ? `${words(family)}: ${words(leaf.join(":"))}` : words(family));
}

export function ageContext(bucket: AgeBucket): ContextSpec {
  return callable(
    { key: `age:${bucket}`, kind: "age", group: "AGE", label: AGE_BUCKET_LABEL[bucket], subject: bucket, metro: null },
    { "signal.demographics.age": bucket },
  );
}

export function audienceContext(audience: AudienceKey): ContextSpec {
  return callable(
    { key: `audience:${audience}`, kind: "audience", group: "AUDIENCE", label: audienceLabel(audience), subject: audience, metro: null },
    { "signal.demographics.audiences": [audience] },
  );
}

/** A market's pinned locality, null when none is pinned, or "failed" when the lookup threw. */
type Pin = MarketLocality | null | "failed";

/** The pins of the given markets, each looked up once; empty without a locality seam. */
async function pinsFor(markets: readonly MarketId[], localities: LocalityApi | null): Promise<ReadonlyMap<MarketId, Pin>> {
  if (localities === null) return new Map();
  const unique = [...new Set(markets)];
  const settled = await Promise.allSettled(unique.map((m) => Promise.resolve().then(() => localities.market(m))));
  const pins = new Map<MarketId, Pin>();
  unique.forEach((m, i) => {
    const s = settled[i];
    pins.set(m, s?.status === "fulfilled" ? s.value : "failed");
  });
  return pins;
}

function localityContext(
  base: Omit<ContextSpec, "signal" | "gap" | "pending" | "label">,
  market: MarketId,
  pin: Pin | undefined,
  env: ContextEnv,
  labelOf: (name: string) => string,
): ContextSpec {
  const pinned = pin === undefined || pin === null || pin === "failed" ? null : pin;
  const label = labelOf(pinned === null ? marketLabel(market) : safeName(pinned.label));
  if (pinned === null) {
    const why =
      env.localities === null
        ? "no market locality is available to this build"
        : pin === "failed"
          ? "its locality lookup failed"
          : "its locality is not pinned";
    const pending = env.localities === null || pin === "failed";
    return notCallable({ ...base, label }, "unavailable", `${label}: ${why}, so the context was not called.`, pending);
  }
  return callable({ ...base, label }, { "signal.location": pinned.entityId });
}

/** A market metro context (SHARE metros, RANK metro contexts): the market's pinned locality id (G2). */
export function metroContext(market: MarketId, pin: Pin | undefined, env: ContextEnv): ContextSpec {
  return localityContext(
    { key: `metro:${market}`, kind: "metro", group: "METRO", subject: market, metro: gazetteerMetro(market) },
    market,
    pin,
    env,
    (name) => name,
  );
}

/** The whole-city context of a gazetteer metro (RANK city, the comparator of tenant fit). */
export function cityContext(metro: MetroId, pin: Pin | undefined, env: ContextEnv): ContextSpec {
  return localityContext({ key: `city:${metro}`, kind: "city", group: "CITY", subject: metro, metro }, metro, pin, env, (name) => `${name} (city)`);
}

/** "lon,lat" → POINT(lon lat), longitude first as WKT requires. */
export function pointWkt(lonLat: string): string {
  const [lon = "", lat = ""] = lonLat.split(",");
  return `POINT(${lon} ${lat})`;
}

/** A site: the gazetteer neighbourhood's POLYGON, or a POINT (G2, P5). No radius: it had no effect (G8). */
export function siteContext(area: AreaArg, env: ContextEnv): ContextSpec {
  const base = { key: `site:${area.metro}:${area.ref}`, kind: "site" as const, group: "SITE" as const, subject: area.ref, metro: area.metro };
  if (area.kind === "point") return callable({ ...base, label: `Site ${area.ref}` }, { "signal.location": pointWkt(area.ref) });
  if (env.geo === null) {
    return notCallable({ ...base, label: area.ref }, "unavailable", `${area.ref}: no gazetteer to read the area from.`, true);
  }
  const name = env.geo.neighbourhood(area.metro, area.ref)?.name ?? null;
  const wkt = env.geo.polygonWkt(area.metro, area.ref);
  const label = safeName(name ?? area.ref);
  if (wkt === null) {
    return notCallable(
      { ...base, label },
      "unavailable",
      `${label} is not a ${METRO_LABEL[area.metro]} neighbourhood in the gazetteer, so the site was not called.`,
      false,
    );
  }
  return callable({ ...base, label }, { "signal.location": wkt });
}

/** The seed-only context: the seeds' taste with no location or audience. */
export function signalContext(label: string): ContextSpec {
  return callable({ key: "none", kind: "none", group: "SIGNAL", label, subject: null, metro: null }, {});
}

/** RANK's input contexts as specs, in input order; a context repeated exactly is kept once. */
export async function rankContexts(
  contexts: readonly RankContext[],
  env: ContextEnv,
  signalLabel: string,
): Promise<{ specs: ContextSpec[]; repeated: string[] }> {
  const markets = contexts.flatMap((c) => (c.kind === "city" ? [c.metro] : c.kind === "metro" ? [c.market] : []));
  const pins = await pinsFor(markets, env.localities);
  const specs: ContextSpec[] = [];
  const repeated: string[] = [];
  for (const c of contexts) {
    const spec =
      c.kind === "none"
        ? signalContext(signalLabel)
        : c.kind === "site"
          ? siteContext(c.area, env)
          : c.kind === "city"
            ? cityContext(c.metro, pins.get(c.metro), env)
            : c.kind === "metro"
              ? metroContext(c.market, pins.get(c.market), env)
              : c.kind === "audience"
                ? audienceContext(c.audience)
                : ageContext(c.age);
    if (specs.some((s) => s.key === spec.key)) repeated.push(spec.label);
    else specs.push(spec);
  }
  return { specs, repeated };
}

/** SHARE's contexts in grid order: ages youngest first, then audiences and metros as given. */
export async function shareContexts(
  input: { ages: readonly AgeBucket[]; audiences: readonly AudienceKey[]; metros: readonly MarketId[] },
  env: ContextEnv,
): Promise<ContextSpec[]> {
  const pins = await pinsFor(input.metros, env.localities);
  const ages = AgeBucket.options.filter((b) => input.ages.includes(b));
  return [...ages.map(ageContext), ...input.audiences.map(audienceContext), ...input.metros.map((m) => metroContext(m, pins.get(m), env))];
}
