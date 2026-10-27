import { AudienceKey, audienceParent, type Pillar, type ToolInput } from "@ct/contracts";
import { audienceDenial, sanitizeQlooName, type AudienceCatalogueRead, type AudienceSegment, type QlooClient } from "@ct/qloo";
import type { SkillCall } from "./tools";

/**
 * The run's AUDIENCES (D21): the pinned catalogue (kv, tools/dev/audiences.ts), read once at run
 * start and filtered by the desk allowlist. The ANALYST is offered these segments only, and code
 * refuses a tool call that sends any other audience before a Qloo call is made; the Qloo client
 * still refuses denied families on its own (fixed rule).
 */

export interface RunAudiences {
  /** The catalogue's state at run start; "failed" when kv could not be read. */
  state: AudienceCatalogueRead["state"] | "failed";
  /** Segments this desk may send, in catalogue order. */
  segments: readonly AudienceSegment[];
  /** Their keys, for the tool-argument check. */
  keys: ReadonlySet<string>;
}

export const NO_RUN_AUDIENCES: RunAudiences = { state: "missing", segments: [], keys: new Set() };

/** Catalogue segments the desk may send: well-formed keys that D21 allows on it, each once. */
export function audienceSegmentsFor(pillar: Pillar, segments: readonly AudienceSegment[]): AudienceSegment[] {
  const seen = new Set<string>();
  return segments.filter((s) => {
    const keep = AudienceKey.safeParse(s.key).success && audienceDenial(s.key, pillar) === null && !seen.has(s.key);
    if (keep) seen.add(s.key);
    return keep;
  });
}

/** Reads the catalogue for this run; a client without one, or a failed read, offers no audiences. */
export async function loadRunAudiences(qloo: Pick<QlooClient, "audienceCatalogue">, pillar: Pillar): Promise<RunAudiences> {
  let read: AudienceCatalogueRead;
  try {
    if (qloo.audienceCatalogue === undefined) return NO_RUN_AUDIENCES;
    read = await qloo.audienceCatalogue();
  } catch {
    return { ...NO_RUN_AUDIENCES, state: "failed" };
  }
  const segments = audienceSegmentsFor(pillar, read.segments);
  return { state: read.state, segments, keys: new Set(segments.map((s) => s.key)) };
}

const LABEL_MAX = 40;
const words = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The AUDIENCES block: one line per family, each segment as its key, with its label in brackets
 * when the label says more than the key's leaf. Labels come from Qloo, so they are cleaned and
 * their angle brackets escaped.
 */
export function audiencesBlock(segments: readonly AudienceSegment[], none: string): string {
  if (segments.length === 0) return `AUDIENCES: ${none}`;
  const families = new Map<string, string[]>();
  for (const s of segments) {
    const family = audienceParent(s.key);
    const leaf = s.key.slice(`urn:audience:${family}:`.length);
    const label = sanitizeQlooName(s.label, LABEL_MAX).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const item = label === "" || words(label) === words(leaf) ? s.key : `${s.key} (${label})`;
    families.set(family, [...(families.get(family) ?? []), item]);
  }
  const lines = [...families].map(([family, items]) => `- ${family}: ${items.join(", ")}`);
  return `AUDIENCES (send only these keys):\n${lines.join("\n")}`;
}

/** The audiences a call would send: share_of_taste audiences and rank_candidates audience contexts. */
export function callAudiences(call: Pick<SkillCall, "tool" | "input">): string[] {
  if (call.tool === "share_of_taste") return [...(call.input as ToolInput<"share_of_taste">).audiences];
  if (call.tool === "rank_candidates") {
    return (call.input as ToolInput<"rank_candidates">).contexts.flatMap((c) => (c.kind === "audience" ? [c.audience] : []));
  }
  return [];
}

/** The audiences of a call that are not on the run's AUDIENCES list, each once, in call order. */
export function unlistedAudiences(call: Pick<SkillCall, "tool" | "input">, keys: ReadonlySet<string>): string[] {
  return [...new Set(callAudiences(call).filter((a) => !keys.has(a)))];
}
