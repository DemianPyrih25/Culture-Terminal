import type {
  BarGroup,
  DatasetId,
  DigestRow,
  EvidenceId,
  Finding,
  Flag,
  Metric,
  NoValueReason,
  RankedRow,
  RegisteredEntity,
  SkillCtx,
  ValueCell,
} from "@ct/contracts";
import type { FindingDraft } from "../../findings";
import { addSkillMetric } from "../common";
import { displayRanks, fixed2, rankText, safeFullName, safeName, safeText } from "../format";
import { facetLabel, SPEC_FACETS, type FacetProfile, type FacetTag, type TagContrast } from "./facets";
import { AGE_BARS, ageExtremes, GENDER_BARS, youthIndex, type DnaProfile, type Indices } from "./profiles";

/**
 * What one audience_dna run writes: a bounded metric set, the DNA Bars (diverging for one subject,
 * a dumbbell around 0 for two), the youth and facet-tag Ranked lists, and the digest rows. Indices
 * are relative to the average audience, never shares; a missing block is "not measured".
 */

export type DnaRole = "target" | "compare" | "peer";

export interface DnaSubject {
  entity: RegisteredEntity;
  role: DnaRole;
  profile: DnaProfile;
}

/** The second series of the DNA figure: a named subject, the average of the measured peers, or none. */
export type Counterpart = { kind: "subject"; subject: DnaSubject } | { kind: "peers"; peers: DnaSubject[]; indices: Indices } | null;

export interface DnaRun {
  ctx: SkillCtx;
  flags: Set<Flag>;
  evidenceIds: EvidenceId[];
  metrics: Metric[];
  findings: Finding[];
  datasetIds: DatasetId[];
  notices: string[];
}

export function addFinding(run: DnaRun, draft: FindingDraft, metricIds: readonly Metric["id"][]): void {
  run.findings.push(run.ctx.ledger.addFinding({ ...draft, metricIds: [...metricIds] }));
}

/** "+0.30", "-0.18"; an index that rounds to zero prints "0.00", never "-0.00". */
function signed2(x: number): string {
  const text = fixed2(x);
  if (Number(text) === 0) return fixed2(0);
  return x > 0 ? `+${text}` : text;
}

/** Indices per measured subject; null when it has none. */
export function indicesOf(subject: DnaSubject): Indices | null {
  return subject.profile.measured ? subject.profile : null;
}

function reasonOf(subject: DnaSubject): NoValueReason {
  return subject.profile.measured ? "not_measured" : subject.profile.reason;
}

export const peerAverageName = (n: number): string => `peers (average of ${n})`;

// Metrics ----------------------------------------------------------------------------------------------

export interface YouthRank {
  rank: number;
  of: number;
}

/** Youth ranks among the measured subjects (1 = youngest-leaning); null for the unmeasured. */
export function youthRanks(subjects: readonly DnaSubject[]): (YouthRank | null)[] {
  const ys = subjects.map((s) => {
    const i = indicesOf(s);
    return i === null ? null : youthIndex(i);
  });
  const of = ys.filter((y) => y !== null).length;
  return displayRanks(ys).map((r) => (r === null || of < 2 ? null : { rank: r, of }));
}

interface Who {
  name: string;
  refs: readonly string[];
  /** Behind each index: one block (MEASURED), or several averaged (DERIVED). */
  averaged: number | null;
}

function whoOf(subject: DnaSubject): Who {
  return { name: safeName(subject.entity.name), refs: [subject.entity.ref], averaged: null };
}

function youthMetric(
  run: DnaRun,
  who: Who,
  indices: Indices | null,
  reason: NoValueReason,
  rank: YouthRank | null,
  evidenceIds: readonly EvidenceId[],
): Metric {
  const y = indices === null ? null : youthIndex(indices);
  const ranked = rank === null ? "" : ` · rank ${rankText(rank.rank, rank.of)}, youngest first`;
  return addSkillMetric(run.ctx.ledger, {
    key: "dna.youth_index",
    label: `${who.name} youth index (Y)`,
    subjectRefs: who.refs,
    value: y,
    reason,
    display: y === null ? "" : `${signed2(y)}${ranked}`,
    unit: "index",
    badge: "DERIVED",
    formulaId: "dna.youth_index",
    evidenceIds,
    // Y averages four age indices; a peer average rests on that many blocks.
    n: who.averaged ?? 4,
    comparator: "BASELINE",
  });
}

export interface ProfileMetrics {
  /** In AgeBucket order; empty when the subject is not measured. */
  age: Metric[];
  gender: Metric[];
  youth: Metric;
}

/**
 * The full set for the subjects the figure shows: six age indices, two gender indices and Y. Raw
 * indices are MEASURED with n = the indices of their kind in the block (6 age, 2 gender), so a
 * reading rests on its whole profile; a peer average is DERIVED with n = the blocks averaged. An
 * unmeasured subject gets Y alone, UNAVAILABLE with its reason.
 */
function profileMetrics(
  run: DnaRun,
  who: Who,
  indices: Indices | null,
  reason: NoValueReason,
  rank: YouthRank | null,
  evidenceIds: readonly EvidenceId[],
): ProfileMetrics {
  const push = (m: Metric): Metric => {
    run.metrics.push(m);
    return m;
  };
  if (indices === null) return { age: [], gender: [], youth: push(youthMetric(run, who, null, reason, null, evidenceIds)) };
  const badge = who.averaged === null ? "MEASURED" : "DERIVED";
  const index = (key: "dna.age_index" | "dna.gender_index", label: string, value: number, kindN: number): Metric =>
    push(
      addSkillMetric(run.ctx.ledger, {
        key,
        label: `${who.name} ${label}`,
        subjectRefs: who.refs,
        value,
        reason,
        display: signed2(value),
        unit: "index",
        badge,
        formulaId: key,
        evidenceIds,
        n: who.averaged ?? kindN,
        comparator: "BASELINE",
      }),
    );
  const age = AGE_BARS.map(([bucket, label]) => index("dna.age_index", `age index ${label}`, indices.age[bucket], AGE_BARS.length));
  const gender = GENDER_BARS.map(([g, label]) =>
    index("dna.gender_index", `gender index, ${label.toLowerCase()}`, indices.gender[g], GENDER_BARS.length),
  );
  return { age, gender, youth: push(youthMetric(run, who, indices, reason, rank, evidenceIds)) };
}

export function subjectMetrics(
  run: DnaRun,
  subject: DnaSubject,
  rank: YouthRank | null,
  evidenceIds: readonly EvidenceId[],
): ProfileMetrics {
  return profileMetrics(run, whoOf(subject), indicesOf(subject), reasonOf(subject), rank, evidenceIds);
}

export function peerAverageMetrics(
  run: DnaRun,
  peers: readonly DnaSubject[],
  indices: Indices,
  evidenceIds: readonly EvidenceId[],
): ProfileMetrics {
  const who = { name: peerAverageName(peers.length), refs: peers.map((p) => p.entity.ref), averaged: peers.length };
  return profileMetrics(run, who, indices, "not_measured", null, evidenceIds);
}

export function subjectYouthMetric(run: DnaRun, subject: DnaSubject, rank: YouthRank | null, evidenceIds: readonly EvidenceId[]): Metric {
  const m = youthMetric(run, whoOf(subject), indicesOf(subject), reasonOf(subject), rank, evidenceIds);
  run.metrics.push(m);
  return m;
}

/**
 * dna.distinctive_tags for the target: tags in the SPEC facets that it carries and fewer than half
 * of its peers of the same type carry, cited to the facet-tag call. Not measured without such target
 * tags, without a same-type peer whose tags are known, or when that call did not answer (`gap`).
 */
export function distinctiveMetric(
  run: DnaRun,
  target: RegisteredEntity,
  profile: FacetProfile,
  evidenceIds: readonly EvidenceId[],
  gap: NoValueReason,
): Metric {
  const measurable = evidenceIds.length > 0 && profile.total > 0 && profile.peers > 0;
  const n = profile.distinctive.length;
  const m = addSkillMetric(run.ctx.ledger, {
    key: "dna.distinctive_tags",
    label: `distinctive facet tags of ${safeName(target.name)} (on fewer than half of its peers of the same type)`,
    subjectRefs: [target.ref],
    value: measurable ? n : null,
    reason: gap,
    // "distinctive" names what the count is, so a sentence that quotes the display reads on its own.
    display: `${n} of ${profile.total} facet tags distinctive, vs ${profile.peers} ${profile.peers === 1 ? "peer" : "peers"} of the same type`,
    unit: "count",
    badge: "DERIVED",
    formulaId: "dna.distinctive_tags",
    evidenceIds,
    n: profile.peers,
    comparator: "PEERS",
  });
  run.metrics.push(m);
  return m;
}

// Datasets ---------------------------------------------------------------------------------------------

const INDEX_CAPTION =
  "Relative affinity indices from −1 to 1 around the average audience (0), not population shares; gender is binary in the source.";
const TAG_CAPTION = "Qloo entity tags grouped by namespace: qualitative catalogue descriptors, not measured customer attributes.";
const CORE_FACETS = SPEC_FACETS.map((f) => f.label.toLowerCase()).join(", ");
const NOT_MEASURED: ValueCell = { value: null, reason: "not_measured" };

function cellOf(indices: Indices | null, reason: NoValueReason, read: (i: Indices) => number): ValueCell {
  return indices === null ? { value: null, reason } : { value: read(indices), reason: null };
}

/**
 * The DNA figure: one diverging series around 0, or a dumbbell of the target against the compare
 * subject, its one measured peer or the peers' average (A08 figure 1, A04 figure 2). Skipped when no
 * series has a value.
 */
export function addDnaBars(run: DnaRun, target: DnaSubject, counterpart: Counterpart, evidenceIds: readonly EvidenceId[]): void {
  type Series = { key: string; label: string; ref: RegisteredEntity["ref"] | null; indices: Indices | null; reason: NoValueReason };
  const ofSubject = (s: DnaSubject): Series => ({
    key: s.entity.ref,
    label: safeFullName(s.entity.name),
    ref: s.entity.ref,
    indices: indicesOf(s),
    reason: reasonOf(s),
  });
  const series: Series[] = [ofSubject(target)];
  if (counterpart?.kind === "subject") series.push(ofSubject(counterpart.subject));
  if (counterpart?.kind === "peers") {
    const label = `Peers, average of ${counterpart.peers.length}`;
    series.push({ key: "peers", label, ref: null, indices: counterpart.indices, reason: "not_measured" });
  }
  if (series.every((s) => s.indices === null)) return;

  const bars = (rows: readonly (readonly [string, string, (i: Indices) => number])[]) =>
    rows.map(([key, label, read]) => ({
      key,
      label,
      tagRef: null,
      values: series.map((s) => cellOf(s.indices, s.reason, read)),
      isNew: false,
      ranks: null,
    }));
  const ageBars = AGE_BARS.map(([b, label]) => [b, label, (i: Indices) => i.age[b]] as const);
  const genderBars = GENDER_BARS.map(([g, label]) => [g, label, (i: Indices) => i.gender[g]] as const);
  const groups: BarGroup[] = [
    { key: "age", label: "Age", family: null, bars: bars(ageBars) },
    { key: "gender", label: "Gender", family: null, bars: bars(genderBars) },
  ];
  const second = series[1];
  const two = second !== undefined;
  const versus = second === undefined ? "" : ` vs ${second.ref === null ? "peers" : safeName(second.label)}`;
  const dataset = run.ctx.ledger.addDataset({
    kind: "Bars",
    title: `Audience DNA · ${safeName(target.entity.name)}${versus}`,
    evidenceIds: [...evidenceIds],
    formulaIds: ["dna.age_index", "dna.gender_index"],
    payload: {
      mode: two ? "butterfly" : "diverging",
      comparator: "BASELINE",
      valueLabel: "Affinity index, −1 to 1 (0 = average audience)",
      unit: "index",
      series: series.map((s) => ({ key: s.key, label: s.label, ref: s.ref, group: null })),
      groups,
      method: null,
      domain: null,
      caption: INDEX_CAPTION,
      ...(two ? { display: "dumbbell" as const } : {}),
      baseline: 0,
    },
  });
  run.datasetIds.push(dataset.id);
}

/** Every subject ranked by youth index, unmeasured last (three or more subjects). */
export function addYouthRanking(
  run: DnaRun,
  subjects: readonly DnaSubject[],
  ranks: readonly (YouthRank | null)[],
  evidenceIds: readonly EvidenceId[],
): void {
  const rows: RankedRow[] = subjects
    .map((s, i) => ({ s, rank: ranks[i] ?? null, indices: indicesOf(s) }))
    .sort((a, b) => (a.rank?.rank ?? Infinity) - (b.rank?.rank ?? Infinity))
    .map(({ s, rank, indices }): RankedRow => ({
      key: s.entity.ref,
      rank: rank?.rank ?? null,
      label: safeFullName(s.entity.name),
      sublabel: s.role === "peer" ? null : s.role,
      ref: s.entity.ref,
      tagRef: null,
      type: s.entity.type,
      cells: [cellOf(indices, reasonOf(s), youthIndex)],
      flags: s.role === "target" ? ["TARGET"] : [],
      explain: [],
    }));
  const target = subjects[0];
  const dataset = run.ctx.ledger.addDataset({
    kind: "Ranked",
    title: `Youth index · ${safeName(target?.entity.name ?? "")} and peers`,
    evidenceIds: [...evidenceIds],
    formulaIds: ["dna.youth_index"],
    payload: {
      columns: [{ key: "youth", label: "Youth index (Y)", unit: "index", comparator: "BASELINE" }],
      groups: [{ key: "set", label: "Audience set", rows }],
      caption: `Y = mean of the two youngest age indices minus the two oldest. ${INDEX_CAPTION}`,
    },
  });
  run.datasetIds.push(dataset.id);
}

function tagRow(tag: FacetTag, peerCount: number | null, sublabel: string | null): RankedRow {
  return {
    key: tag.tagId,
    rank: null,
    label: safeText(tag.name, 60),
    sublabel,
    ref: null,
    tagRef: null,
    type: null,
    cells: [peerCount === null ? NOT_MEASURED : { value: peerCount, reason: null }],
    flags: [],
    explain: [],
  };
}

function peerColumn(peers: number) {
  return {
    key: "peers",
    label: peers > 0 ? `Same-type peers with the tag (of ${peers})` : "Same-type peers with the tag",
    unit: "count" as const,
    comparator: "PEERS" as const,
  };
}

/**
 * The target's facet profile: one group per facet, distinctive tags first (they carry the
 * "distinctive" sublabel); groups outside the SPEC facets are unflagged context.
 */
export function addFacetList(run: DnaRun, target: RegisteredEntity, profile: FacetProfile, evidenceIds: readonly EvidenceId[]): void {
  const peers = `${profile.peers} ${profile.peers === 1 ? "peer" : "peers"}`;
  const rule =
    profile.peers > 0
      ? ` Distinctive: a tag in the core facets (${CORE_FACETS}) carried by fewer than half of its ${peers} of the same type with known tags; other namespaces are listed as context, never scored.`
      : " No peer of the same type has known tags, so no tag is called distinctive.";
  const dataset = run.ctx.ledger.addDataset({
    kind: "Ranked",
    title: `Facet tags · ${safeName(target.name)}`,
    evidenceIds: [...evidenceIds],
    formulaIds: ["dna.distinctive_tags"],
    payload: {
      columns: [peerColumn(profile.peers)],
      groups: profile.groups.map((g) => ({
        key: g.facet,
        label: g.label,
        rows: g.tags.map((t) => tagRow(t.tag, t.peerCount, t.distinctive === true ? "distinctive" : null)),
      })),
      caption: `${TAG_CAPTION}${rule}`,
    },
  });
  run.datasetIds.push(dataset.id);
}

/** Tags only on A, on both and only on B (qualitative presence, D15), each with its facet as sublabel. */
export function addTagContrast(
  run: DnaRun,
  a: RegisteredEntity,
  b: RegisteredEntity,
  contrast: TagContrast,
  peers: { peerCount: (tagId: string) => number | null; peers: number; evidenceIds: readonly EvidenceId[] },
): void {
  const rows = (tags: readonly FacetTag[]) => tags.map((t) => tagRow(t, peers.peerCount(t.tagId), facetLabel(t.facet)));
  const dataset = run.ctx.ledger.addDataset({
    kind: "Ranked",
    title: `Facet tags · ${safeName(a.name)} vs ${safeName(b.name)}`,
    evidenceIds: [...peers.evidenceIds],
    formulaIds: ["dna.distinctive_tags"],
    payload: {
      columns: [peerColumn(peers.peers)],
      groups: [
        { key: "a_only", label: `Only ${safeFullName(a.name)}`, rows: rows(contrast.aOnly) },
        { key: "shared", label: "Both", rows: rows(contrast.shared) },
        { key: "b_only", label: `Only ${safeFullName(b.name)}`, rows: rows(contrast.bOnly) },
      ],
      caption: `${TAG_CAPTION} Presence only: a tag missing from one side is not a measured difference.`,
    },
  });
  run.datasetIds.push(dataset.id);
}

// Digest rows ------------------------------------------------------------------------------------------

/** Tag names for a digest row: Qloo text, cleaned and capped. */
export function tagNames(tags: readonly FacetTag[], max = 6): string | null {
  if (tags.length === 0) return null;
  const shown = tags.slice(0, max).map((t) => safeText(t.name, 40));
  const rest = tags.length - shown.length;
  return safeText(`${shown.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}`, 240);
}

/**
 * A subject's row names the metric that holds its youth index and the age buckets it leans to and
 * away from (labels, not numbers), so the model cites the index rather than typing it.
 */
export function subjectRow(subject: DnaSubject, youth: Metric, tagCount: number): DigestRow {
  const indices = indicesOf(subject);
  const values: DigestRow["values"] = {
    role: subject.role,
    type: subject.entity.type,
    demographics: indices === null ? reasonOf(subject) : "measured",
    youth_metric: youth.id,
    tags: tagCount,
  };
  if (indices !== null) {
    const { highest, lowest } = ageExtremes(indices);
    values.highest_age = AGE_BARS.find(([b]) => b === highest)?.[1] ?? null;
    values.lowest_age = AGE_BARS.find(([b]) => b === lowest)?.[1] ?? null;
  }
  return { ref: subject.entity.ref, name: safeName(subject.entity.name), values };
}

export function peerAverageRow(peers: readonly DnaSubject[], indices: Indices, youth: Metric): DigestRow {
  const { highest, lowest } = ageExtremes(indices);
  return {
    ref: null,
    name: peerAverageName(peers.length),
    values: {
      role: "peer_average",
      peers: peers.map((p) => p.entity.ref).join(", "),
      youth_metric: youth.id,
      highest_age: AGE_BARS.find(([b]) => b === highest)?.[1] ?? null,
      lowest_age: AGE_BARS.find(([b]) => b === lowest)?.[1] ?? null,
    },
  };
}
