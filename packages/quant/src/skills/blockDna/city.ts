import {
  MetroId,
  type CacheProbe,
  type CityAreaArg,
  type EvidenceId,
  type LocalityApi,
  type MarketId,
  type MarketLocality,
  type NoValueReason,
  type QlooEntity,
  type SkillCtx,
  type SkillResult,
  type ToolInput,
} from "@ct/contracts";
import { emptyResultFinding } from "../../findings";
import { attemptAllKeepingFailures, countUncached, type Attempt } from "../common";
import { skillErrorResult, type DigestTarget } from "../digest";
import { marketLabel } from "../metros";
import {
  addBundle,
  BRAND,
  brandParams,
  brandRowsOf,
  callFlags,
  count,
  familyCounts,
  gapOf,
  LIST_FAMILIES,
  metasOf,
  okValue,
  rowsOf,
  sideCalls,
  sideRequests,
  SOUND,
  TAG,
  tagParams,
  tagSummary,
  type BrandAttempt,
  type TagAttempt,
} from "./calls";
import { BRAND_TAKE, compareLists, NEW_AREA_TOP, panelList, rankBrandRows, rankTagRows, TAG_TAKE, type RankedList } from "./fingerprint";
import { cityLocation } from "./location";
import {
  addBlockDnaBars,
  addBrandMetrics,
  addFamilyMetrics,
  addFindingDraft,
  addLocalBrandsTable,
  addNewTagsFinding,
  blockDigestRows,
  finishBlockRun,
  localBrands,
  panelBase,
  type BlockFrame,
  type BlockRun,
  type BrandResult,
  type FamilyResult,
} from "./outputs";

/**
 * Block DNA of a whole city (`{kind: "city", market}`), for city_compare: the city's own top-50 tag
 * lists against the other map cities' lists pooled into one panel by average rank (FORMULAS
 * block.panel_rank), comparator BASELINE. Every list is a city side that tools/dev/cli/warm-metros.ts
 * pins for the 13 map cities, built by the same request builders, so a warmed run reads the whole
 * panel from the cache; a market outside the map cities costs its own two or three calls.
 */

type CityInput = ToolInput<"block_dna"> & { area: CityAreaArg };

/** A panel of fewer lists than this is too narrow to stand for "the other map cities". */
export const PANEL_MIN_CITIES = 6;

/** The map cities a city is compared with: every map city but itself. */
export function panelMetros(market: MarketId): MetroId[] {
  return MetroId.options.filter((m) => m !== market);
}

interface PanelPin {
  metro: MetroId;
  locality: MarketLocality;
}

async function panelPins(localities: LocalityApi, market: MarketId): Promise<PanelPin[]> {
  const metros = panelMetros(market);
  const pins = await Promise.all(metros.map((m) => localities.market(m)));
  return metros.flatMap((metro, i) => {
    const locality = pins[i];
    return locality === null || locality === undefined ? [] : [{ metro, locality }];
  });
}

/**
 * Network calls a city fingerprint would cost now: its own lists and the panel's, cached ones free
 * (the map cities' are pinned). Without the locality pins nothing can be keyed, so every list counts.
 */
export async function estimateCityCalls(market: MarketId, brands: boolean, probe: CacheProbe, localities: LocalityApi | null): Promise<number> {
  const panel = panelMetros(market);
  if (localities === null) return (1 + panel.length) * sideCalls(brands);
  const own = await localities.market(market);
  if (own === null) return 0;
  const pins = await panelPins(localities, market);
  if (pins.length < PANEL_MIN_CITIES) return 0;
  return countUncached(
    probe,
    "/v2/insights",
    [own, ...pins.map((p) => p.locality)].flatMap((l) => sideRequests(cityLocation(l), brands)),
  );
}

/** The panel's lists: those that answered with ranked items, or why there are too few. */
function pooled(attempts: readonly (TagAttempt | BrandAttempt | undefined)[], lists: readonly (RankedList | null)[], take: number): { list: RankedList | null; size: number; gap: NoValueReason | null } {
  const usable = lists.filter((l): l is RankedList => l !== null && l.ranks.size > 0);
  if (usable.length >= PANEL_MIN_CITIES) return { list: panelList(usable, take), size: usable.length, gap: null };
  const gap: NoValueReason = attempts.some((a) => a?.kind === "truncated") ? "budget_truncated" : attempts.some((a) => a?.kind === "failed") ? "error" : "not_measured";
  return { list: null, size: usable.length, gap };
}

const tagListOf = (a: TagAttempt | undefined, families: typeof LIST_FAMILIES): RankedList | null => {
  const v = okValue(a);
  return v === null ? null : rankTagRows(v.data.results.tags, families);
};

function failedCodes(attempts: readonly (Attempt<unknown> | undefined)[]): string {
  return [...new Set(attempts.flatMap((a) => (a?.kind === "failed" ? [a.code] : [])))].join(", ");
}

export async function runCityFingerprint(input: CityInput, ctx: SkillCtx): Promise<SkillResult> {
  const out: DigestTarget = { tool: "block_dna", step: input.step_id };
  const market = input.area.market;
  const name = marketLabel(market);
  if (ctx.localities === null) return skillErrorResult(out, `This run has no Qloo locality pins, so ${name} cannot be read as a whole city.`);
  const own = await ctx.localities.market(market);
  if (own === null) return skillErrorResult(out, `No Qloo locality is pinned for ${market}; use a market id from the MARKETS list.`);
  const pins = await panelPins(ctx.localities, market);
  if (pins.length < PANEL_MIN_CITIES) {
    return skillErrorResult(
      out,
      `Only ${pins.length} other map cities have a pinned Qloo locality; a city fingerprint needs at least ${PANEL_MIN_CITIES} to compare ${name} with.`,
    );
  }

  const city = cityLocation(own);
  const brands = input.include_brands;
  const panel = pins.map((p) => cityLocation(p.locality));
  // Everything at once: the client's per-run limiter paces the calls, and pinned ones come from the cache.
  const [ownAttempts, ownBrandAttempts, panelTagA, panelMusicA, panelBrandA] = await Promise.all([
    attemptAllKeepingFailures([() => ctx.qloo.insights(TAG, tagParams(city, false)), () => ctx.qloo.insights(TAG, tagParams(city, true))], ctx.signal),
    attemptAllKeepingFailures(brands ? [() => ctx.qloo.insights(BRAND, brandParams(city))] : [], ctx.signal),
    attemptAllKeepingFailures(panel.map((p) => () => ctx.qloo.insights(TAG, tagParams(p, false))), ctx.signal),
    attemptAllKeepingFailures(panel.map((p) => () => ctx.qloo.insights(TAG, tagParams(p, true))), ctx.signal),
    attemptAllKeepingFailures(brands ? panel.map((p) => () => ctx.qloo.insights(BRAND, brandParams(p))) : [], ctx.signal),
  ]);
  const [ownTagsA, ownMusicA] = ownAttempts;
  const [ownBrandsA] = ownBrandAttempts;
  // Nothing about the city itself came back: there is no fingerprint to keep, so the error goes to the caller.
  if (ownTagsA?.kind === "failed" && ownMusicA?.kind !== "ok") throw ownTagsA.error;

  const run: BlockRun = { ctx, flags: new Set(), evidenceIds: [], metrics: [], findings: [], datasetIds: [], registered: [], notices: [] };

  // Lists.
  const ownTags = tagListOf(ownTagsA, LIST_FAMILIES);
  const ownMusic = tagListOf(ownMusicA, SOUND);
  const panelTagLists = panelTagA.map((a) => tagListOf(a, LIST_FAMILIES));
  const panelMusicLists = panelMusicA.map((a) => tagListOf(a, SOUND));
  const tagsPanel = pooled(panelTagA, panelTagLists, TAG_TAKE);
  const musicPanel = pooled(panelMusicA, panelMusicLists, TAG_TAKE);
  const ownGap = gapOf(ownTagsA, ownTags);
  const ownMusicGap = gapOf(ownMusicA, ownMusic);
  const frame: BlockFrame = { area: { key: market, name, subject: market }, method: null, base: panelBase(name, tagsPanel.size || pins.length) };

  // Evidence.
  const ownCalls = metasOf([ownTagsA, ownMusicA]);
  const ownE = addBundle(run, "block_dna", {
    purpose: `City tag fingerprint of ${name} (Qloo locality)`,
    calls: ownCalls,
    status: ownGap === null && ownMusicGap === null ? "ok" : ownCalls.length === 0 ? "empty" : "partial",
    summary:
      `${tagSummary(ownTags, ownGap === "not_measured" ? null : ownGap, "taste tag")}${ownTags === null ? "" : ` (${familyCounts(ownTags)})`}; ` +
      `${tagSummary(ownMusic, ownMusicGap === "not_measured" ? null : ownMusicGap, "music tag")}.`,
    flags: callFlags([rowsOf(ownTagsA), rowsOf(ownMusicA)], [ownTags, ownMusic], ownCalls, ownTagsA?.kind === "truncated" || ownMusicA?.kind === "truncated"),
  });
  const panelAttempts: (TagAttempt | undefined)[] = [...panelTagA, ...panelMusicA];
  const panelCalls = metasOf(panelAttempts);
  const panelE = addBundle(run, "block_dna", {
    purpose: `Map-city panel: the tag fingerprints of ${pins.length} other map cities (Qloo localities)`,
    calls: panelCalls,
    status: tagsPanel.gap === null && musicPanel.gap === null && panelAttempts.every((a) => a?.kind === "ok") ? "ok" : panelCalls.length === 0 ? "empty" : "partial",
    summary: `${tagsPanel.size} of ${pins.length} city tag lists and ${musicPanel.size} of ${pins.length} city music lists had ranked tags.`,
    flags: callFlags(panelAttempts.map(rowsOf), [...panelTagLists, ...panelMusicLists], panelCalls, panelAttempts.some((a) => a?.kind === "truncated")),
  });
  const tagEvidence = [ownE, panelE].filter((e): e is EvidenceId => e !== null);

  // No ranked tags for the city itself: nothing to compare.
  if (ownTags === null || ownGap !== null) {
    if (ownGap === "budget_truncated") run.flags.add("BUDGET_TRUNCATED");
    if (ownGap === "not_measured") {
      addFindingDraft(run, emptyResultFinding({ what: `the tag fingerprint of ${name}`, suggestion: null }), []);
      return finishBlockRun(run, out, "empty", []);
    }
    run.notices.push(`${name}'s own tag list is missing (${ownGap}), so nothing was compared.`);
    return finishBlockRun(run, out, "partial", []);
  }

  // Families.
  const listCompared = compareLists(ownTags, tagsPanel.list, TAG_TAKE + 1, NEW_AREA_TOP);
  const families: FamilyResult[] = LIST_FAMILIES.map((family) => ({
    family,
    items: listCompared.filter((c) => c.item.family === family),
    gap: tagsPanel.gap,
    areaSize: ownTags.ranks.size,
    evidenceIds: tagEvidence,
  }));
  families.push({
    family: "SOUND",
    items: ownMusic === null || ownMusicGap !== null ? [] : compareLists(ownMusic, musicPanel.list, TAG_TAKE + 1, NEW_AREA_TOP),
    gap: ownMusicGap ?? musicPanel.gap,
    areaSize: ownMusic?.ranks.size ?? 0,
    evidenceIds: tagEvidence,
  });

  // Brands.
  let brandResult: BrandResult | null = null;
  if (brands) {
    const ownList = okValue(ownBrandsA) === null ? null : rankBrandRows(okValue(ownBrandsA)?.data.results.entities ?? []);
    const panelBrandLists = panelBrandA.map((a) => {
      const v = okValue(a);
      return v === null ? null : rankBrandRows(v.data.results.entities);
    });
    const brandPanel = pooled(panelBrandA, panelBrandLists, BRAND_TAKE);
    const brandAttempts: (BrandAttempt | undefined)[] = [ownBrandsA, ...panelBrandA];
    const brandCalls = metasOf(brandAttempts);
    const gateDropped = [ownList, ...panelBrandLists].reduce((s, l) => s + (l?.gateDropped ?? 0), 0);
    const ownBrandGap = gapOf(ownBrandsA, ownList);
    const flags = callFlags(brandAttempts.map(brandRowsOf), [ownList, ...panelBrandLists], brandCalls, brandAttempts.some((a) => a?.kind === "truncated"));
    if (gateDropped > 0) flags.push("QUALITY_GATE_DROPPED");
    const brandE = addBundle(run, "block_dna", {
      purpose: `Brands of ${name} against ${frame.base.label}`,
      calls: brandCalls,
      status: ownBrandGap === null && brandPanel.gap === null ? "ok" : brandCalls.length === 0 ? "empty" : "partial",
      summary:
        `${ownList?.ranks.size ?? 0} ${name} brands ranked; ${brandPanel.size} of ${pins.length} city brand lists answered` +
        `${gateDropped > 0 ? `; ${gateDropped} below the popularity quality gate skipped` : ""}.`,
      flags,
      qualityGateDrops: gateDropped,
    });
    const raw = new Map<string, QlooEntity>((okValue(ownBrandsA)?.data.results.entities ?? []).map((e) => [e.entity_id, e]));
    brandResult = {
      items: ownList !== null && ownBrandGap === null && brandPanel.list !== null ? compareLists(ownList, brandPanel.list, BRAND_TAKE + 1, null) : null,
      gap: ownBrandGap ?? brandPanel.gap,
      raw,
      areaSize: ownList?.ranks.size ?? 0,
      evidenceIds: brandE === null ? [] : [brandE],
    };
  }

  // Ledger output. BLOCK_NEW_TAGS names what sets the city apart from the panel; its follow-up is the
  // concept_vector open call on those tags (a city is no site for tenants), so city_compare has a lead
  // to pivot on even when the question names no brand and no lift map counts supply.
  const familyMetrics = families.map((fam) => addFamilyMetrics(run, frame, fam));
  addNewTagsFinding(run, frame, families, familyMetrics, frame.base.label);
  const brandMetrics = brandResult === null ? [] : addBrandMetrics(run, frame, brandResult);
  addBlockDnaBars(run, frame, families, familyMetrics, tagEvidence);
  if (brandResult !== null) addLocalBrandsTable(run, frame, brandResult, brandMetrics);

  // Notices.
  run.notices.push(
    `${name} read from its pinned Qloo locality and compared with ${frame.base.label}: each tag's panel rank is its average rank across their top-${TAG_TAKE} lists.`,
  );
  if (tagsPanel.gap !== null) {
    run.notices.push(`WHO, VIBE and WHAT are not compared: only ${tagsPanel.size} of ${pins.length} map-city tag lists came back (${tagsPanel.gap}).`);
  }
  if (ownMusicGap !== null) run.notices.push(`SOUND is not measured: ${name}'s music list is missing (${ownMusicGap}).`);
  else if (musicPanel.gap !== null) run.notices.push(`SOUND is not compared: only ${musicPanel.size} of ${pins.length} map-city music lists came back (${musicPanel.gap}).`);
  else if (musicPanel.size !== tagsPanel.size) run.notices.push(`SOUND compares against ${musicPanel.size} cities' music lists.`);
  if (brandResult !== null && brandResult.items !== null && localBrands(brandResult).length === 0) {
    run.notices.push(`No brand ranks higher in ${name} than across ${frame.base.label}.`);
  }
  const all = [...ownAttempts, ...ownBrandAttempts, ...panelTagA, ...panelMusicA, ...panelBrandA];
  const failed = all.filter((a) => a?.kind === "failed");
  if (failed.length > 0) {
    run.notices.push(`${count(failed.length, "call")} of ${all.length} failed (${failedCodes(all)}); a panel list that failed is left out of the average.`);
  }

  const partial = all.some((a) => a?.kind !== "ok") || families.some((f) => f.gap !== null) || (brandResult?.gap ?? null) !== null;
  return finishBlockRun(run, out, partial ? "partial" : "ok", blockDigestRows(familyMetrics, brandMetrics));
}
