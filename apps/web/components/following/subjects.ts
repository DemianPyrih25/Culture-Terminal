import type { Follow, FollowCreate, FollowKind, FollowRerun, Intent, Job, ResolvedMention } from "@ct/contracts";
import { brandFollowQuestion, FOLLOW_LABEL_MAX, followSubjectKey, JOB_VALUES, METRO_LABEL, QUESTION_MAX_CHARS } from "@ct/contracts/values";

/**
 * What a note can be followed by (PLAN §8.1, §2.4): its main brand, its place (a map city, or an area
 * in one) and its question. Pure, so the server (which reads the subject from the run, never from the
 * browser) and the Follow button (which only needs to know what to offer and what is followed) read a
 * note the same way.
 */

/** What a note says about itself: its question, the job it was read as, CLERK's reading and the resolves. */
export interface NoteFacts {
  question: string;
  job: string | null;
  intent: Intent | null;
  resolves: readonly ResolvedMention[];
}

export interface NoteSubject {
  kind: FollowKind;
  /** The brand, the place or the question, as the button and the Following row name it. */
  label: string;
  /**
   * followSubjectKey of a brand or a place. Null for a question: its key is the server's answer-cache
   * hash, so the browser matches a followed question by its words (sameQuestion).
   */
  subjectKey: string | null;
  rerun: FollowRerun;
}

/** One thing the Follow control offers: what it shows, and the POST /api/follows body that follows it. */
export interface FollowOption {
  subject: NoteSubject;
  create: FollowCreate;
}

/** A label held to FOLLOW_LABEL_MAX, cut on a word with an ellipsis. */
export function clipLabel(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (clean.length <= FOLLOW_LABEL_MAX) return clean;
  const cut = clean.slice(0, FOLLOW_LABEL_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > FOLLOW_LABEL_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const fold = (q: string) => q.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

/** Whether two questions are the same words, ignoring case and spacing. */
export function sameQuestion(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

/** The note's main brand: the primary mention, matched exactly to a Qloo brand (never an offered candidate). */
export function mainBrand(resolves: readonly ResolvedMention[]): string | null {
  const hit = resolves.find((r) => r.role === "primary" && r.match === "exact" && r.entityType === "brand" && r.name?.trim());
  return hit?.name?.trim() ?? null;
}

/** The note's place: its map city, with the area when the question names one. */
export function notePlace(intent: Intent | null): { metro: string; area: string | null; label: string } | null {
  const metro = intent?.geo.metro ?? null;
  if (metro === null) return null;
  const area = intent?.geo.area?.trim() || null;
  const city = METRO_LABEL[metro];
  return { metro, area, label: area ? `${area}, ${city}` : city };
}

function rerunOf(facts: NoteFacts): FollowRerun {
  const job = (JOB_VALUES as readonly (string | null)[]).includes(facts.job) ? (facts.job as Job) : null;
  return {
    question: facts.question.trim().slice(0, QUESTION_MAX_CHARS),
    job,
    metro: facts.intent?.geo.metro ?? null,
  };
}

/**
 * Every subject the note can be followed by, brand first, then place, then the question. A brand
 * needs an exact match, a place a map city; a question needs words. Each re-runs the note's own
 * question, read as its job and metro.
 */
export function noteSubjects(facts: NoteFacts): NoteSubject[] {
  if (facts.question.trim() === "") return [];
  const rerun = rerunOf(facts);
  const out: NoteSubject[] = [];
  const brand = mainBrand(facts.resolves);
  if (brand) out.push({ kind: "brand", label: clipLabel(brand), subjectKey: followSubjectKey("brand", brand), rerun });
  const place = notePlace(facts.intent);
  if (place) {
    out.push({ kind: "place", label: clipLabel(place.label), subjectKey: followSubjectKey("place", place.metro, place.area ?? ""), rerun });
  }
  out.push({ kind: "question", label: clipLabel(facts.question), subjectKey: null, rerun });
  return out;
}

/** What a brand's profile (/d/[entity]) can be followed by: the brand, re-run as a brand-health note. */
export function profileSubject(name: string): NoteSubject {
  return {
    kind: "brand",
    label: clipLabel(name),
    subjectKey: followSubjectKey("brand", name),
    rerun: { question: brandFollowQuestion(name).slice(0, QUESTION_MAX_CHARS), job: "brand_health", metro: null },
  };
}

/** The Follow options of a note: one per subject, each followed from the run (the server reads the subject). */
export function noteFollowOptions(runId: string, facts: NoteFacts): FollowOption[] {
  return noteSubjects(facts).map((subject) => ({ subject, create: { from: "run", runId, kind: subject.kind } }));
}

/** The Follow option of a brand profile. */
export function profileFollowOption(name: string): FollowOption {
  return { subject: profileSubject(name), create: { from: "profile", name: name.trim() } };
}

/** The visitor's follow of this subject, if any. */
export function findFollow(follows: readonly Follow[], subject: NoteSubject): Follow | undefined {
  return follows.find((f) =>
    f.kind !== subject.kind
      ? false
      : subject.subjectKey !== null
        ? f.subjectKey === subject.subjectKey
        : sameQuestion(f.rerun.question, subject.rerun.question),
  );
}
