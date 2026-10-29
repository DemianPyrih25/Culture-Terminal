import type { BarGroup, DatasetEnvelope, RankedPayload } from "@ct/contracts";
// The one shared tag-noise filter (ANSWER_QUALITY §10) is quant's isNoiseTag. Its module has no imports,
// so the page takes it through the "@ct/quant/tag-noise" subpath and not the @ct/quant barrel (its skills
// would bloat the client bundle).
import { isNoiseTag } from "@ct/quant/tag-noise";

export { isNoiseTag };

/** The music genre tag type: Block DNA's SOUND family reads it. */
const MUSIC_TYPE = "urn:tag:genre:music";

/** A Qloo tag id ("urn:tag:…"): Block DNA bars and audience tag rows carry it as their key. */
function tagIdOf(key: string): string | null {
  return key.startsWith("urn:tag:") ? key : null;
}

/** Whether a figure row names a tag that carries no taste. Entity rows (brands, places, people) never do. */
function isNoiseRow(row: { key: string; label: string; tagRef: string | null }, type: string | null): boolean {
  const tagId = tagIdOf(row.key);
  if (tagId === null && row.tagRef === null) return false;
  return isNoiseTag({ name: row.label, tagId, type });
}

function cleanBarGroups(groups: readonly BarGroup[]): BarGroup[] | null {
  let changed = false;
  const out: BarGroup[] = [];
  for (const g of groups) {
    const type = g.family === "SOUND" ? MUSIC_TYPE : null;
    const bars = g.bars.filter((b) => !isNoiseRow(b, type));
    if (bars.length === g.bars.length) {
      out.push(g);
      continue;
    }
    changed = true;
    // A group the filter emptied is dropped; a group that was empty already stays as it was.
    if (bars.length > 0) out.push({ ...g, bars });
  }
  return changed ? out : null;
}

function cleanRankedGroups(groups: RankedPayload["groups"]): RankedPayload["groups"] | null {
  let changed = false;
  const out = groups.map((g) => {
    const rows = g.rows.filter((r) => !isNoiseRow(r, null));
    if (rows.length === g.rows.length) return g;
    changed = true;
    // Groups stay, even empty: a tag contrast reads its groups by key (a_only, shared, b_only).
    return { ...g, rows };
  });
  return changed ? out : null;
}

const cleaned = new WeakMap<DatasetEnvelope, DatasetEnvelope>();

/**
 * A dataset as the page shows it: tag rows that carry no taste (a place name, "Usa", or for music a
 * nationality or a generic word) are dropped by quant's isNoiseTag. QUANT already drops them from new
 * runs; this applies the same filter at display time, so a run stored before the filter shows the same
 * lists. Counts a stored run wrote into its numbers (a NEW-tag count) are not recomputed.
 * Returns the same object when nothing is dropped, so memoised views keep their identity.
 */
export function withoutNoiseTags<D extends DatasetEnvelope>(dataset: D): D;
export function withoutNoiseTags<D extends DatasetEnvelope>(dataset: D | null): D | null;
export function withoutNoiseTags<D extends DatasetEnvelope>(dataset: D | null): D | null {
  if (dataset === null) return null;
  if (dataset.kind !== "Bars" && dataset.kind !== "Ranked") return dataset;
  const known = cleaned.get(dataset);
  if (known) return known as D;
  let out: DatasetEnvelope = dataset;
  if (dataset.kind === "Bars") {
    const groups = cleanBarGroups(dataset.payload.groups);
    if (groups) out = { ...dataset, payload: { ...dataset.payload, groups } };
  } else {
    const groups = cleanRankedGroups(dataset.payload.groups);
    if (groups) out = { ...dataset, payload: { ...dataset.payload, groups } };
  }
  cleaned.set(dataset, out);
  return out as D;
}
