import { AudienceKey, audienceParent, IsoDateTime, type QlooAudience, type QlooParams } from "@ct/contracts";
import { z } from "zod";
import { AUDIENCE_ALLOWLIST, audienceDenial } from "./audiences";
import type { QlooEnv } from "./store";
import { sanitizeQlooName } from "./trim";

/**
 * The audience catalogue (D21, PLAN §11.2 C5): the segments of the allowed families, read from
 * /v2/audiences and pinned in kv by tools/dev/audiences.ts, then offered to the ANALYST as AUDIENCES.
 * Only public audience keys and display names are stored, never Qloo's entity ids (D29): the value
 * holds nothing that could not be shown. A run reads it once at start (QlooClient.audienceCatalogue).
 * Denied families and audiences are dropped at write time and refused again by the client (fixed rule).
 */

export const AUDIENCE_CATALOGUE_KV_KEY = "audience_catalogue";
/** Synthetic segments (QLOO_MOCK=1) live under a key of their own, as the mock locality pins do. */
export const MOCK_AUDIENCE_CATALOGUE_KV_KEY = "audience_catalogue.mock";

export function audienceCatalogueKvKey(env: QlooEnv): string {
  return env === "mock" ? MOCK_AUDIENCE_CATALOGUE_KV_KEY : AUDIENCE_CATALOGUE_KV_KEY;
}

/** The families the catalogue reads: every family D21 allows on some desk, in allowlist order. */
export const AUDIENCE_CATALOGUE_FAMILIES: readonly string[] = [...new Set(Object.values(AUDIENCE_ALLOWLIST.desks).flat())];

/** One /v2/audiences per family; take 100 is the endpoint's maximum and covers every family (C5). */
export const AUDIENCE_CATALOGUE_TAKE = 100;

export function audienceCatalogueParams(family: string): QlooParams {
  return { "filter.parents.types": [`urn:audience:${family}`], take: AUDIENCE_CATALOGUE_TAKE };
}

/** Longest stored label; Qloo's audience names are a few words. */
export const AUDIENCE_LABEL_MAX = 60;

export const AudienceSegment = z.strictObject({ key: AudienceKey, label: z.string().min(1).max(AUDIENCE_LABEL_MAX) });
export type AudienceSegment = z.infer<typeof AudienceSegment>;

export const StoredAudienceCatalogue = z.strictObject({
  version: z.literal(1),
  fetchedAt: IsoDateTime,
  families: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.array(AudienceSegment)),
});
export type StoredAudienceCatalogue = z.infer<typeof StoredAudienceCatalogue>;

/** pinned: the value parses. missing: kv holds none. malformed: it does not parse, so no segment is offered. */
export type AudienceCatalogueState = "pinned" | "missing" | "malformed";

export interface AudienceCatalogueRead {
  state: AudienceCatalogueState;
  /** Every stored segment that is a well-formed key of its family and not denied (D21), in stored order. */
  segments: AudienceSegment[];
  fetchedAt: string | null;
}

export const EMPTY_AUDIENCE_CATALOGUE: AudienceCatalogueRead = { state: "missing", segments: [], fetchedAt: null };

/**
 * A stored kv value as the segments a run may offer. The families are checked again on read, so a
 * value written by hand or by an older build can never offer a denied or misfiled segment.
 */
export function readAudienceCatalogue(raw: unknown): AudienceCatalogueRead {
  if (raw === undefined || raw === null) return EMPTY_AUDIENCE_CATALOGUE;
  const parsed = StoredAudienceCatalogue.safeParse(raw);
  if (!parsed.success) return { state: "malformed", segments: [], fetchedAt: null };
  const seen = new Set<string>();
  const segments = Object.entries(parsed.data.families).flatMap(([family, rows]) =>
    rows.filter((s) => {
      const keep = audienceParent(s.key) === family && audienceDenial(s.key, null) === null && !seen.has(s.key);
      if (keep) seen.add(s.key);
      return keep;
    }),
  );
  return { state: "pinned", segments, fetchedAt: parsed.data.fetchedAt };
}

/** What one family's /v2/audiences answer gives the catalogue, with counts of what was left out. */
export interface AudienceFamilyRead {
  family: string;
  segments: AudienceSegment[];
  /** Rows in the answer. */
  rows: number;
  /** Rows dropped: not a well-formed key of this family, or a duplicate. */
  dropped: number;
  /** Rows of this family that D21 denies on every desk (dropped too). */
  denied: number;
}

/**
 * One family's rows as catalogue segments: well-formed keys of that family only, denied ones dropped
 * (D21), labels cleaned of control characters and links (the leaf stands in for an empty one). Qloo's
 * entity ids are never read.
 */
export function audienceFamilySegments(family: string, rows: readonly Pick<QlooAudience, "id" | "name">[]): AudienceFamilyRead {
  const segments: AudienceSegment[] = [];
  const seen = new Set<string>();
  let denied = 0;
  let dropped = 0;
  for (const row of rows) {
    const key = typeof row.id === "string" ? row.id.trim() : "";
    if (!AudienceKey.safeParse(key).success || audienceParent(key) !== family || seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    if (audienceDenial(key, null) !== null) {
      denied += 1;
      continue;
    }
    const label = sanitizeQlooName(row.name, AUDIENCE_LABEL_MAX).trim();
    segments.push({ key, label: label === "" ? key.slice(key.lastIndexOf(":") + 1) : label });
  }
  return { family, segments, rows: rows.length, dropped, denied };
}

/** The kv value for a set of family reads, in AUDIENCE_CATALOGUE_FAMILIES order. */
export function storedAudienceCatalogue(reads: readonly AudienceFamilyRead[], fetchedAt: Date): StoredAudienceCatalogue {
  const families: Record<string, AudienceSegment[]> = {};
  for (const family of AUDIENCE_CATALOGUE_FAMILIES) {
    const read = reads.find((r) => r.family === family);
    if (read !== undefined) families[family] = read.segments;
  }
  return StoredAudienceCatalogue.parse({ version: 1, fetchedAt: fetchedAt.toISOString(), families });
}
