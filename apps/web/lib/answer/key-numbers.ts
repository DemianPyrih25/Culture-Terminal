import type { BarsPayload, DatasetEnvelope, GeoLiftNeighbourhood, GeoLiftPayload, Job, Metric, RankedPayload, SlatePayload } from "@ct/contracts";
import type { BriefFigure, BriefKeyFigure } from "../brief";
import { METRO_LABEL } from "@ct/contracts/values";
import { areaSupply, MIN_BUSY_AREA_VENUES, supplyUnknown, THIN_SUPPLY_LABEL } from "../../components/figures/lift-scale";
import { bestLiftFigure, datasetOf, type ChartContext } from "./charts";
import { DOMAIN_COLUMN, ENTITY_NOUN } from "./copy";
import { cityFingerprints } from "./charts";
import { contrastColumns, fitText, isNeighbourhood, isScored, isTagContrast, isTwins, isVerdicts, rhoText, rhoWord, twinRows, verdictGroups } from "./job-shapes";
import { ageLeanWord, genderLeanWord, peakAge, signed } from "./dna";
import type { AnswerDatasets, AnswerKeyNumber, KeyNumberTag } from "./types";

/** "ZIP 37206 (East Nashville)" reads "East Nashville" (the same rule as the answer's areaName). */
const placeName = (name: string) => /\(([^)]+)\)\s*$/.exec(name)?.[1]?.trim() || name;

/**
 * The answer's three key numbers per job (§2.7–2.10, G-W9): the value worded the way the design prints it
 * ("0.84 match", "#2 of 6", "Leans older"), its label and context line, and the footnote Source opens. Each
 * job's designed numbers come first; any slot left is filled by the run's other key figures as the run
 * printed them. Never a number the run did not measure.
 */

export const KEY_NUMBER_MAX = 3;

interface Input {
  job: Job | null;
  figures: readonly BriefKeyFigure[];
  metrics: Readonly<Record<string, Metric>>;
  allFigures: readonly BriefFigure[];
  fetched: AnswerDatasets;
  ctx: ChartContext;
  /** The neighbourhood the question names, as asked (CLERK's geo.area); null when it names none. */
  askedArea?: string | null;
}

type Number_ = Extract<AnswerKeyNumber, { variant: "number" | "word" | "name" }>;

const metricOf = (k: BriefKeyFigure, metrics: Input["metrics"]): Metric | null => (k.metric ? (metrics[k.metric.id] ?? null) : null);

/** Whether a key figure is of a formula or metric key. */
function isOf(k: BriefKeyFigure, metrics: Input["metrics"], ...ids: string[]): boolean {
  if (!k.metric || k.value === null) return false;
  const m = metricOf(k, metrics);
  return ids.includes(k.metric.formulaId) || (m !== null && ids.includes(m.key));
}

/** The number a key figure stands for: the metric's value, else the first number of its text. */
function numberOf(k: BriefKeyFigure, metrics: Input["metrics"]): number | null {
  const m = metricOf(k, metrics);
  if (m && m.value !== null) return m.value;
  const text = (k.value ?? "").replace("−", "-");
  const found = /-?\d+(?:\.\d+)?/.exec(text);
  return found ? Number(found[0]) : null;
}

/** "Tenant fit · Lantern Hi-Fi Bar" → "Lantern Hi-Fi Bar"; null without a " · ". */
function afterDot(label: string): string | null {
  const at = label.indexOf(" · ");
  return at >= 0 ? label.slice(at + 3).trim() : null;
}

/** "with Granite Outfitters" → "Granite Outfitters". */
const withoutWith = (text: string | null) => (text ? text.replace(/^(with|vs)\s+/i, "").trim() : null);

/** "site 1 of 5" or "1 of 24" in a display: [1, 5]. */
function rankIn(text: string | null | undefined): [number, number] | null {
  const m = /(\d+) of (\d+)/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const generic = (k: BriefKeyFigure): Number_ => ({
  key: k.key,
  variant: "number",
  value: k.value ?? "No data",
  label: k.label,
  tag: null,
  context: k.comparator,
  footnote: k.footnote,
});

function one(key: string, value: string, label: string, context: string | null, footnote: number | null, extra: Partial<Pick<Number_, "variant" | "tag">> = {}): Number_ {
  return { key, variant: extra.variant ?? "number", value, label, tag: extra.tag ?? null, context, footnote };
}

/** The first dataset of a kind (with a test) among the report's figures. */
function findData<K extends DatasetEnvelope["kind"]>(input: Input, kind: K, test: (d: Extract<DatasetEnvelope, { kind: K }>) => boolean = () => true) {
  for (const f of input.allFigures) {
    const d = datasetOf(f, input.fetched);
    if (d && d.kind === kind && test(d as Extract<DatasetEnvelope, { kind: K }>)) return { figure: f, data: d as Extract<DatasetEnvelope, { kind: K }> };
  }
  return null;
}

/** A two-series index figure's subject values by group key, e.g. its AGE bands. */
function subjectBands(payload: BarsPayload, ctx: ChartContext, groupKey: string): { label: string; value: number | null }[] {
  const at = Math.max(
    0,
    payload.series.findIndex((s) => s.ref !== null && s.ref === ctx.subjectRef),
  );
  const group = payload.groups.find((g) => g.key === groupKey);
  return group ? group.bars.map((b) => ({ label: b.label, value: b.values[at]?.value ?? null })) : [];
}

// Per job --------------------------------------------------------------------------------------------------------

function ageLean(k: BriefKeyFigure, input: Input): Number_ | null {
  const v = numberOf(k, input.metrics);
  const word = ageLeanWord(v, metricOf(k, input.metrics)?.level === "about_level");
  if (word === null || v === null) return null;
  return one(k.key, word, "Age lean", `${signed(v)} vs the average audience`, k.footnote, { variant: "word" });
}

function brandHealth(input: Input, take: (test: (k: BriefKeyFigure) => boolean) => BriefKeyFigure | null): Number_[] {
  const out: Number_[] = [];
  const sim = take((k) => isOf(k, input.metrics, "subs.similarity"));
  if (sim) {
    const peer = withoutWith(sim.comparator);
    out.push(one(sim.key, `${sim.value} match`, "Closest audience", peer ? `${peer} · 1.00 = identical` : "1.00 = identical", sim.footnote));
  }
  const dist = take((k) => isOf(k, input.metrics, "subs.distinctiveness"));
  if (dist) {
    const r = rankIn(dist.value);
    out.push(one(dist.key, r ? `#${r[0]} of ${r[1]}` : (dist.value ?? "No data"), "Most distinctive fans", "among the brands compared", dist.footnote));
  }
  const youth = take((k) => isOf(k, input.metrics, "dna.youth_index", "share.youth_tilt"));
  const lean = youth ? ageLean(youth, input) : null;
  if (lean) out.push(lean);
  return out;
}

function headToHead(input: Input, take: (test: (k: BriefKeyFigure) => boolean) => BriefKeyFigure | null): AnswerKeyNumber[] {
  const out: AnswerKeyNumber[] = [];
  const { ctx } = input;
  const sim = take((k) => isOf(k, input.metrics, "subs.similarity"));
  if (sim) out.push(one(sim.key, `${sim.value} match`, "Taste overlap", "each other's closest rival", sim.footnote));
  const a = ctx.subject;
  const b = ctx.second;
  if (a && b) {
    // Counted from the figures the answer draws, so the numbers and "Who wins where" always agree.
    const splits: { test: (d: BarsPayload) => boolean; group: string; label: string }[] = [
      { test: (p) => p.display === "split" || p.groups.some((g) => g.key === "METRO"), group: "METRO", label: "Cities where it ranks first" },
      { test: (p) => p.groups.some((g) => g.key === "AGE"), group: "AGE", label: "Age groups where it ranks first" },
    ];
    for (const s of splits) {
      const found = findData(input, "Bars", (d) => d.payload.series.length === 2 && s.test(d.payload));
      if (!found) continue;
      const p = found.data.payload;
      const ai = Math.max(0, p.series.findIndex((x) => x.ref !== null && x.ref === ctx.subjectRef));
      const bi = ai === 0 ? 1 : 0;
      const band = p.evenBand ?? 0;
      const bars = (p.groups.find((g) => g.key === s.group) ?? p.groups[0])?.bars ?? [];
      if (bars.length === 0) continue;
      let wa = 0;
      let wb = 0;
      for (const bar of bars) {
        const x = bar.values[ai]?.value ?? null;
        const y = bar.values[bi]?.value ?? null;
        if (x === null || y === null) continue;
        if (x > y + band) wa += 1;
        else if (y > x + band) wb += 1;
      }
      // The run's own "metros won" figures are what the city count stands for.
      if (s.group === "METRO") {
        take((k) => isOf(k, input.metrics, "share.metros_won"));
        take((k) => isOf(k, input.metrics, "share.metros_won"));
      }
      out.push({
        key: `${s.group.toLowerCase()}:${found.figure.datasetId}`,
        variant: "split",
        label: s.label,
        sides: [
          { name: a, value: String(wa), tone: "subject" },
          { name: b, value: String(wb), tone: "second" },
        ],
        tag: null,
        context: null,
        footnote: found.figure.footnote,
      });
    }
  }
  return out;
}

/** A lift as the key numbers print it: "1.48×". */
const liftText = (lift: number) => `${lift.toFixed(2)}×`;

/** The metric of a key about one area (its first subject ref), from the run's metrics. */
function areaMetric(input: Input, key: string, areaId: string): Metric | null {
  return Object.values(input.metrics).find((m) => m.key === key && m.subjectRefs[0] === areaId) ?? null;
}

interface NamedArea {
  n: GeoLiftNeighbourhood;
  rank: [number, number] | null;
  lift: Metric | null;
}

const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** The map's areas whose name holds every word of the asked name ("90026" in "ZIP 90026 (Echo Park)"). */
function areasNamed(data: GeoLiftPayload, asked: string): GeoLiftNeighbourhood[] {
  const want = words(asked);
  if (want.length === 0) return [];
  return data.neighbourhoods.filter((x) => {
    const have = new Set(words(x.name));
    return want.every((w) => have.has(w));
  });
}

/**
 * The areas the question names, in its order, each with its rank among the areas with a lift (the
 * run's lift.rank metric, else the map's own order): the map's focusAreas, else (a run stored before
 * maps carried them) the one area of the map whose name holds the asked name.
 */
function namedAreas(input: Input, data: GeoLiftPayload): NamedArea[] {
  const byId = (data.focusAreas ?? []).flatMap((id) => data.neighbourhoods.find((x) => x.id === id) ?? []);
  const asked = input.askedArea ?? null;
  const byName = asked === null ? [] : areasNamed(data, asked);
  const found = byId.length > 0 ? byId : byName.length === 1 ? byName : [];
  const ranked = data.neighbourhoods.filter((x) => x.lift !== null).sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0));
  return found.map((n) => {
    const at = ranked.findIndex((x) => x.id === n.id);
    const rank = rankIn(areaMetric(input, "lift.rank", n.id)?.display) ?? (at >= 0 ? ([at + 1, ranked.length] as [number, number]) : null);
    return { n, rank, lift: areaMetric(input, "lift.area", n.id) };
  });
}

/** Why a named area has no reading, in plain words, from its UNAVAILABLE lift metric's label. */
function noReadingWhy(n: GeoLiftNeighbourhood, lift: Metric | null): string {
  const cells = /only (\d+) of the (\d+) gated cells/.exec(lift?.label ?? "");
  if (cells) return `only ${cells[1]} of the ${cells[2]} map cells a reliable reading needs`;
  if (n.reason === "insufficient_n") return "too few map cells for a reliable reading";
  if (n.reason === "coarse") return "the map is too coarse for a reading by area";
  return "no reading for this area in this run";
}

/** A named area first, with its rank among all areas with a lift, or plainly why it has none. */
function yourArea(named: NamedArea, label: string, footnote: number | null): Number_ {
  const { n, rank } = named;
  if (n.lift === null) return one(`area:${n.id}`, n.name, label, `Not enough data: ${noReadingWhy(n, named.lift)}`, footnote, { variant: "word" });
  const where = rank ? `#${rank[0]} of ${rank[1]} areas for this concept · ` : "";
  return one(`area:${n.id}`, n.name, label, `${where}${liftText(n.lift)} the interest of a typical area`, footnote, { variant: "word" });
}

/** The asked area when no area of the map carries its name: said plainly, never answered with another area. */
function notOnMap(asked: string, data: GeoLiftPayload, footnote: number | null): Number_ {
  const context = `No reading of its own: it matches none of the ${METRO_LABEL[data.metro]} area names this map lists`;
  return one("area:asked", asked, "Your area", context, footnote, { variant: "word" });
}

const UNCOUNTED = "Similar venues were not counted in this run, so the number of competitors is unknown, not zero.";

/**
 * Competition in one area, by the supply-label rule (lift-scale areaSupply): unknown with the reason
 * whenever similar venues could not be counted area by area (no venue sample, a supply gap, a sample too
 * thin to read), never 0; "Not enough venue data" for a capped sample's 0 or a count too small for the
 * label it would get; else the area's count in Qloo's venue sample, worded from its white-space quadrant
 * when it has one, which ranks it against the other areas.
 */
function competition(data: GeoLiftPayload | null, n: GeoLiftNeighbourhood | undefined, footnote: number | null): Number_ | null {
  const unknown = data === null || data.supply === null ? (data?.supplyGap ?? UNCOUNTED) : supplyUnknown(data);
  if (unknown !== null) return one("supply:unknown", "Unknown", "Competition", unknown, footnote, { variant: "word" });
  const sample = data?.supply;
  // A counted sample with no area to read it for (or an area it did not count) says nothing here.
  if (!data || !sample || !n || n.supplyCount === null) return null;
  const read = areaSupply(n, data);
  const count = n.supplyCount;
  const where = METRO_LABEL[data.metro];
  if (read.kind === "thin") {
    const context = read.cappedZero
      ? `None of the ${sample.points.length} similar venues in Qloo's capped venue sample for ${where} is in ${n.name}; ` +
        "a capped sample cannot show how many exist there, so competition there is unknown."
      : `Only ${count} similar ${count === 1 ? "venue" : "venues"} in ${n.name} in Qloo's venue sample${sample.capped ? " (capped, so more may exist)" : ""}: ` +
        `too few to call the area crowded or open (${MIN_BUSY_AREA_VENUES} needed for a crowded reading).`;
    return one(`supply:${n.id}`, THIN_SUPPLY_LABEL, "Competition", context, footnote, { variant: "word" });
  }
  const context = `${count} similar ${count === 1 ? "venue" : "venues"} in ${n.name} in Qloo's venue sample${sample.capped ? " (capped, so more may exist)" : ", not every business"}`;
  const quadrant = read.kind === "label" ? read.quadrant : null;
  const few = quadrant === "LATENT_OPEN" || quadrant === "COLD";
  const busy = quadrant === "PROVEN_CROWDED" || quadrant === "SATURATED";
  // A count with no quadrant ranks against nothing, so it stays a count.
  const word = few ? "Few rivals nearby" : busy ? "Busy with rivals" : null;
  return one(`supply:${n.id}`, word ?? String(count), "Competition", context, footnote, { variant: word ? "word" : "number" });
}

function siteSelection(input: Input, take: (test: (k: BriefKeyFigure) => boolean) => BriefKeyFigure | null): Number_[] {
  const geo = bestLiftFigure(input.allFigures, input.fetched);
  const data = geo ? geo.data.payload : null;
  const named = data ? namedAreas(input, data) : [];
  // The named areas' own lift figures print under their names, not again among the top areas.
  for (const a of named) take((x) => isOf(x, input.metrics, "lift.area") && metricOf(x, input.metrics)?.subjectRefs[0] === a.n.id);
  const lifts: BriefKeyFigure[] = [];
  for (let i = 0; i < 3; i += 1) {
    const k = take((x) => isOf(x, input.metrics, "lift.area"));
    if (k) lifts.push(k);
  }
  const namedIsTop = named.some((a) => a.rank?.[0] === 1);
  const [top, ...rest] = namedIsTop ? [undefined, ...lifts] : lifts;
  const topCard = top ? one(top.key, top.label, "Top area", `${top.value} the interest of a typical area`, top.footnote, { variant: "word" }) : null;
  const runners = rest.filter((r): r is BriefKeyFigure => r !== undefined);
  const runnersCard =
    runners.length > 0
      ? one(
          runners.map((r) => r.key).join("+"),
          runners.map((r) => r.label).join(" · "),
          "Runners-up",
          runners.map((r) => r.value).join(" and "),
          runners[0]?.footnote ?? null,
          { variant: "word" },
        )
      : null;
  const footnote = geo?.figure.footnote ?? null;
  const first = named[0];
  const subject = first?.n ?? (top && data ? data.neighbourhoods.find((x) => x.name === top.label) : undefined);
  // Competition is always said for a site question: a count, a relative word, or unknown with the reason.
  const rivals = competition(data, subject, footnote);
  const asked = input.askedArea ?? null;
  const yours = named.map((a, i) => yourArea(a, i === 0 ? "Your area" : "Also named", footnote));
  // An asked area the map does not hold is said plainly, never left out or answered with another area.
  if (yours.length === 0 && asked !== null && data !== null && areasNamed(data, asked).length === 0) yours.push(notOnMap(asked, data, footnote));
  // One named area: it, the top area, then competition. Two or more: the first two, then competition.
  // None: the top area, the runners-up, then competition.
  const cards =
    yours.length > 1
      ? [...yours.slice(0, 2), rivals, topCard]
      : yours.length === 1
        ? [yours[0] ?? null, topCard, rivals, runnersCard]
        : [topCard, runnersCard, rivals];
  return cards.filter((c): c is Number_ => c !== null);
}

function placeArea(input: Input, take: (test: (k: BriefKeyFigure) => boolean) => BriefKeyFigure | null, tenant: boolean): Number_[] {
  const out: Number_[] = [];
  const city = input.ctx.city ?? "the city";
  const fit = tenant ? take((k) => isOf(k, input.metrics, "tenant.fit")) : null;
  if (fit) {
    const v = numberOf(fit, input.metrics);
    const name = afterDot(fit.label);
    const r = rankIn(fit.comparator) ?? rankIn(metricOf(fit, input.metrics)?.display);
    out.push(
      one(fit.key, v === null ? "No data" : `${Math.round(v)}/100`, "Best fit for this corner", [name, r ? `#${r[0]} of ${r[1]}` : null].filter(Boolean).join(" · ") || null, fit.footnote),
    );
  }
  const fresh = take((k) => isOf(k, input.metrics, "block.new_tag"));
  if (fresh) {
    const v = numberOf(fresh, input.metrics);
    out.push(one(fresh.key, v === null ? "No data" : String(Math.round(v)), tenant ? "New tastes on the block" : "New tastes in the area", `new here vs ${city} overall`, fresh.footnote));
  }
  const over = take((k) => isOf(k, input.metrics, "block.rank_delta") && (numberOf(k, input.metrics) ?? 0) > 0);
  if (over) out.push(one(over.key, over.label, "Most over-represented", `${over.value} ranks vs ${city}`, over.footnote, { variant: "word" }));
  if (!tenant) {
    // A climber has risen: a rank shift of zero or less is no "Top climber" (ANSWER_QUALITY §3).
    const climber = take(
      (k) =>
        (isOf(k, input.metrics, "tenant.rank_shift") && (numberOf(k, input.metrics) ?? 0) > 0) ||
        isOf(k, input.metrics, "xdom.under_the_radar"),
    );
    if (climber) {
      const name = afterDot(climber.label) ?? climber.label;
      const gem = isOf(climber, input.metrics, "xdom.under_the_radar");
      out.push(one(climber.key, name, "Top climber", "rising fastest here", climber.footnote, { variant: "word", tag: gem ? "hidden-gem" : null }));
    }
  }
  return out;
}

function sponsorship(input: Input, take: (test: (k: BriefKeyFigure) => boolean) => BriefKeyFigure | null): Number_[] {
  const out: Number_[] = [];
  const slate = findData(input, "Slate");
  const rows = slate ? (slate.data.payload as SlatePayload).rows : [];
  for (let i = 0; i < 2; i += 1) {
    const best = take((k) => isOf(k, input.metrics, "slate.best_fit", "slate.fit"));
    if (!best) break;
    const name = withoutWith(best.comparator) ?? afterDot(best.label) ?? best.label;
    const row = rows.find((r) => r.best?.label === name);
    const r = rankIn(metricOf(best, input.metrics)?.display);
    const tag: KeyNumberTag | null = row?.best?.utr ? "hidden-gem" : null;
    out.push(one(best.key, name, best.label, r ? `${best.value} fit · #${r[0]} of ${r[1]} scored` : `${best.value} fit`, best.footnote, { variant: "name", tag }));
  }
  const gems = take((k) => isOf(k, input.metrics, "slate.utr_count", "slate.under_the_radar"));
  if (gems) {
    const r = rankIn(gems.value);
    out.push(one(gems.key, r ? `${r[0]} of ${r[1]}` : (gems.value ?? "No data"), "Hidden gems", "among the best fits", gems.footnote));
  }
  return out;
}

function marketSelection(input: Input, take: (test: (k: BriefKeyFigure) => boolean) => BriefKeyFigure | null): Number_[] {
  const out: Number_[] = [];
  const { ctx } = input;
  const noun = ctx.subjectType ? ENTITY_NOUN[ctx.subjectType] : "peers";
  const matrix = findData(input, "Matrix", (d) => d.payload.mode === "share");
  const peers = matrix ? Math.max(0, matrix.data.payload.cols.length - 1) : null;
  const won = take((k) => isOf(k, input.metrics, "share.metros_won"));
  if (won) {
    const r = rankIn(metricOf(won, input.metrics)?.display ?? won.value);
    out.push(
      one(won.key, r ? `${r[0]} of ${r[1]}` : (won.value ?? "No data"), ctx.subject ? `Markets where ${ctx.subject} leads` : "Markets it leads", peers ? `vs ${peers} other ${noun}` : null, won.footnote),
    );
  }
  const fits: BriefKeyFigure[] = [];
  for (let i = 0; i < 2; i += 1) {
    const k = take((x) => isOf(x, input.metrics, "share.pct", "slate.market_alignment"));
    if (k) fits.push(k);
  }
  const best = fits[0];
  if (best) {
    const city = afterDot(best.label) ?? best.label;
    const r = rankIn(metricOf(best, input.metrics)?.display);
    out.push(one(best.key, city, "Best-fit city", r ? `#${r[0]} of ${r[1]} ${noun}` : best.comparator, best.footnote, { variant: "word" }));
  }
  const gem = take((k) => isOf(k, input.metrics, "trvl.hidden_pocket"));
  if (gem) {
    out.push(one(gem.key, afterDot(gem.label) ?? gem.label, "Hidden-gem city", "strong fit, smaller market", gem.footnote, { variant: "word", tag: "hidden-gem" }));
  } else if (fits[1]) {
    const next = fits[1];
    const r = rankIn(metricOf(next, input.metrics)?.display);
    out.push(one(next.key, afterDot(next.label) ?? next.label, "Next-best city", r ? `#${r[0]} of ${r[1]} ${noun}` : next.comparator, next.footnote, { variant: "word" }));
  }
  return out;
}

function audienceDiscovery(input: Input, take: (test: (k: BriefKeyFigure) => boolean) => BriefKeyFigure | null): Number_[] {
  const out: Number_[] = [];
  const dna = findData(input, "Bars", (d) => d.payload.method === null && d.payload.groups.some((g) => g.key === "AGE" || g.key === "GENDER"));
  const gender = take((k) => isOf(k, input.metrics, "dna.gender_index", "dna.female_index"));
  if (gender) {
    const v = numberOf(gender, input.metrics);
    const word = genderLeanWord(v, metricOf(gender, input.metrics)?.level === "about_level");
    if (word && v !== null) out.push(one(gender.key, word, "Gender lean", `${signed(v)} vs the average audience`, gender.footnote, { variant: "word" }));
  }
  const bands = dna ? subjectBands(dna.data.payload, input.ctx, "AGE") : [];
  const peak = peakAge(bands);
  if (dna && peak && peak.value !== null) {
    out.push(one(`peak:${dna.figure.datasetId}`, `Peaks at ${peak.label}`, "Age lean", `${signed(peak.value)} vs the average audience`, dna.figure.footnote, { variant: "word" }));
    take((k) => isOf(k, input.metrics, "dna.youth_index"));
  } else {
    const youth = take((k) => isOf(k, input.metrics, "dna.youth_index"));
    const lean = youth ? ageLean(youth, input) : null;
    if (lean) out.push(lean);
  }
  const ranked = findData(input, "Ranked");
  if (ranked) {
    const rows = (ranked.data.payload as RankedPayload).groups.flatMap((g) => g.rows);
    const gems = rows.filter((r) => r.flags.includes("UTR")).length;
    if (gems > 0) out.push(one(`gems:${ranked.figure.datasetId}`, String(gems), "Hidden gems", "strong fit, less known", ranked.figure.footnote));
    // The under-the-radar figures are what this number counts.
    take((k) => isOf(k, input.metrics, "xdom.under_the_radar"));
    take((k) => isOf(k, input.metrics, "xdom.under_the_radar"));
  }
  return out;
}

// Part 9 jobs ----------------------------------------------------------------------------------------------

type Take = (test: (k: BriefKeyFigure) => boolean) => BriefKeyFigure | null;

/** The first Ranked dataset among the report's figures that passes a test. */
function findWhere(input: Input, test: (d: DatasetEnvelope | null) => boolean): { figure: BriefFigure; data: Extract<DatasetEnvelope, { kind: "Ranked" }> } | null {
  for (const f of input.allFigures) {
    const d = datasetOf(f, input.fetched);
    if (d?.kind === "Ranked" && test(d)) return { figure: f, data: d };
  }
  return null;
}

/** The closest twin, what it shares and the next one: each match in words, with the sample it ranks. */
function tasteTwins(input: Input, take: Take): Number_[] {
  const found = findWhere(input, isTwins);
  if (!found) return [];
  const { rows, checked } = twinRows(found.data.payload);
  // The twins' own match figures are what these cards print.
  while (take((k) => isOf(k, input.metrics, "twin.rho")) !== null) continue;
  const fn = found.figure.footnote;
  const id = found.figure.datasetId;
  const of = `of the ${checked} ${checked === 1 ? "area" : "areas"} that could be matched`;
  const top = rows[0];
  if (!top || top.rho === null) {
    return [one(`twin:${id}`, "None found", "Closest twin", `No area could be matched ${of}: too few shared tastes to compare`, fn, { variant: "word" })];
  }
  if (top.rho <= 0) {
    return [one(`twin:${id}`, "None found", "Closest twin", `No area is a match ${of}: the best scores ${rhoText(top.rho)} (1.00 = the same mix of tastes, 0 = unrelated)`, fn, { variant: "word" })];
  }
  const out: Number_[] = [
    one(`twin:${id}`, placeName(top.label), "Closest twin", `Match ${rhoText(top.rho)}, ${rhoWord(top.rho)}, best ${of} (1.00 = the same mix of tastes)`, fn, { variant: "word" }),
  ];
  if (top.sharedNew !== null) {
    take((k) => isOf(k, input.metrics, "twin.shared_new"));
    out.push(one(`twin-new:${id}`, String(top.sharedNew), "New tastes they share", "tastes in both areas' top 20 that are missing from their own city's top 50", fn));
  }
  const next = rows[1];
  if (next && next.rho !== null && next.rho > 0) {
    out.push(one(`twin-next:${id}`, placeName(next.label), "Next closest", `Match ${rhoText(next.rho)}, ${rhoWord(next.rho)}`, fn, { variant: "word" }));
  }
  return out;
}

/** The best partners on one scale, then how many audience tags the brands share. */
function brandCollab(input: Input): Number_[] {
  const out: Number_[] = [];
  const scored = findWhere(input, isScored);
  if (scored) {
    const fitAt = Math.max(0, scored.data.payload.columns.findIndex((c) => c.key === "fit" || c.unit === "pct"));
    const rows = scored.data.payload.groups
      .flatMap((g) => g.rows)
      .filter((r) => r.ref === null || r.ref !== input.ctx.subjectRef)
      .flatMap((r) => {
        const fit = r.cells[fitAt]?.value ?? null;
        return fit === null ? [] : [{ r, fit }];
      })
      .sort((a, b) => b.fit - a.fit);
    rows.slice(0, 2).forEach((x, i) =>
      out.push(
        one(
          `partner:${i}:${scored.figure.datasetId}`,
          x.r.label,
          i === 0 ? "Best-fit partner" : "Next best",
          `Fit ${fitText(x.fit)}, #${i + 1} of the ${rows.length} brands scored on one scale`,
          scored.figure.footnote,
          { variant: "name", tag: x.r.flags.includes("UTR") ? "hidden-gem" : null },
        ),
      ),
    );
  }
  const contrast = findWhere(input, isTagContrast);
  if (contrast) {
    const { shared, total } = contrastColumns(contrast.data.payload);
    if (total > 0) {
      out.push(one(`shared:${contrast.figure.datasetId}`, `${shared} of ${total}`, "Audience tags they share", "tags listed for either brand that both audiences carry", contrast.figure.footnote));
    }
  }
  return out;
}

/** The top artist or podcast of each kind: ranks compare only within a kind. */
function creatorFit(input: Input): Number_[] {
  const out: Number_[] = [];
  const hood = findWhere(input, isNeighbourhood);
  if (hood) {
    for (const g of hood.data.payload.groups) {
      const rows = g.rows.filter((r) => r.rank !== null);
      const top = rows[0];
      if (!top) continue;
      const noun = DOMAIN_COLUMN[top.type ?? g.key]?.label ?? g.label;
      out.push(
        one(`creator:${g.key}:${hood.figure.datasetId}`, top.label, `Top pick: ${noun}`, `#1 of the ${rows.length} checked in this group; ranks compare only within a group`, hood.figure.footnote, {
          variant: "name",
          tag: top.flags.includes("UTR") ? "hidden-gem" : null,
        }),
      );
      if (out.length >= KEY_NUMBER_MAX) break;
    }
    return out;
  }
  const scored = findWhere(input, isScored);
  const rows = scored ? scored.data.payload.groups.flatMap((g) => g.rows).filter((r) => r.rank !== null) : [];
  const top = rows[0];
  if (scored && top) out.push(one(`creator:${scored.figure.datasetId}`, top.label, "Best fit", `#1 of the ${rows.length} scored on one scale`, scored.figure.footnote, { variant: "name" }));
  return out;
}

/** How many AI guesses the data kept and dropped, and the top result no guess named. */
function launchTest(input: Input): Number_[] {
  const found = findWhere(input, isVerdicts);
  if (!found) return [];
  const { counts, body } = verdictGroups(found.data.payload);
  const out: Number_[] = [];
  const checked = counts.keep + counts.veto;
  const fn = found.figure.footnote;
  const id = found.figure.datasetId;
  if (checked > 0) {
    out.push(one(`kept:${id}`, `${counts.keep} of ${checked}`, "AI guesses the data backs", "scored at least as high as the concept's 50th result (its last, when fewer come back)", fn));
    out.push(
      one(`dropped:${id}`, String(counts.veto), "AI guesses dropped", counts.veto > 0 ? "scored below the concept's 50th result (its last, when fewer come back): the data does not back them" : "no guess scored below the concept's 50th result", fn),
    );
  } else {
    out.push(one(`kept:${id}`, "None", "AI guesses checked", "no AI guess could be scored for this concept", fn, { variant: "word" }));
  }
  const add = body.type === "verdicts" ? body.groups.find((g) => g.verdict === "add")?.rows[0] : undefined;
  if (add) out.push(one(`add:${id}`, add.label, "Found in the data", "a top result for the concept that no guess named", fn, { variant: "name" }));
  return out;
}

/** Each compared city's strongest taste against the other map cities. */
function cityCompare(input: Input): Number_[] {
  const out: Number_[] = [];
  for (const p of cityFingerprints(input.allFigures, input.fetched).slice(0, KEY_NUMBER_MAX)) {
    const top = p.top[0];
    const footnote = input.allFigures.find((f) => f.datasetId === p.datasetId)?.footnote ?? null;
    if (!top) {
      out.push(one(`city:${p.datasetId}`, "Nothing stands out", `${p.name} stands out for`, "no taste ranks clearly higher here than in the other cities we map", footnote, { variant: "word" }));
      continue;
    }
    const places = Math.round(top.value);
    out.push(
      one(`city:${p.datasetId}`, top.label, `${p.name} stands out for`, `ranks ${places} ${places === 1 ? "place" : "places"} higher here than in the other cities we map`, footnote, {
        variant: "word",
        tag: top.isNew ? "new-here" : null,
      }),
    );
  }
  return out;
}

/** The answer's key numbers, at most three. */
export function buildKeyNumbers(input: Input): AnswerKeyNumber[] {
  const left = input.figures.filter((k) => k.state === "ready");
  const take = (test: (k: BriefKeyFigure) => boolean): BriefKeyFigure | null => {
    const at = left.findIndex(test);
    if (at < 0) return null;
    const [k] = left.splice(at, 1);
    return k ?? null;
  };
  let designed: AnswerKeyNumber[] = [];
  switch (input.job) {
    case "brand_health":
      designed = brandHealth(input, take);
      break;
    case "head_to_head":
      designed = headToHead(input, take);
      break;
    case "site_selection":
      designed = siteSelection(input, take);
      break;
    case "tenant_mix":
      designed = placeArea(input, take, true);
      break;
    case "area_profile":
      designed = placeArea(input, take, false);
      break;
    case "sponsorship":
      designed = sponsorship(input, take);
      break;
    case "market_selection":
      designed = marketSelection(input, take);
      break;
    case "audience_discovery":
      designed = audienceDiscovery(input, take);
      break;
    case "taste_twins":
      designed = tasteTwins(input, take);
      break;
    case "brand_collab":
      designed = brandCollab(input);
      break;
    case "creator_fit":
      designed = creatorFit(input);
      break;
    case "launch_test":
      designed = launchTest(input);
      break;
    case "city_compare":
      designed = cityCompare(input);
      break;
    default:
      break;
  }
  const out = designed.slice(0, KEY_NUMBER_MAX);
  for (const k of left) {
    if (out.length >= KEY_NUMBER_MAX) break;
    if (k.value === null) continue;
    out.push(generic(k));
  }
  return out;
}
