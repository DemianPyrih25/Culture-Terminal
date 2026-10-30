import type { EVIDENCE_SOURCE_VALUES, PUBLIC_SOURCE_VALUES } from "./enums";

/** Zod-free provenance helpers; ../ledger.ts holds the schemas. Typed structurally so this file stays zod-free. */

type EvidenceSourceV = (typeof EVIDENCE_SOURCE_VALUES)[number];
type PublicSourceV = (typeof PUBLIC_SOURCE_VALUES)[number];

/** The part of a provenance request these helpers read: its source (absent on Qloo requests stored before Part 9). */
interface SourcedRequest {
  source?: EvidenceSourceV | undefined;
  method: string;
}

export function isPublicProvenanceRequest<R extends SourcedRequest>(r: R): r is R & { source: PublicSourceV } {
  return r.source !== undefined && r.source !== "qloo";
}

export function isQlooProvenanceRequest<R extends SourcedRequest>(r: R): r is R & { source?: "qloo" | undefined } {
  return !isPublicProvenanceRequest(r);
}

/** The source a provenance request belongs to. */
export function provenanceSource(r: SourcedRequest): EvidenceSourceV {
  return r.source ?? "qloo";
}
