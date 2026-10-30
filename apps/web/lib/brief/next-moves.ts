import type { Pillar } from "@ct/contracts";
import { PILLAR_VALUES } from "@ct/contracts/values";
import { parseCommand } from "../grammar/parse";
import { DESK_LABEL } from "./format";
import type { BriefNextMove } from "./types";

/**
 * Next moves as the follow-up bar's chips (SPEC §7.3): each opens the Ask page with its question and
 * this brief as the parent, and names the desk it lands on. The report carries a label and a question
 * only. The ANALYST writes plain labels and a question that names what its desk studies (a block,
 * markets, rivals, an audience), so a typed command's own desk comes first, then a desk prefix (notes
 * written while the prompt asked for "LOCATION · East Nashville block"), then the label's and the
 * question's words; CLERK decides for real when the child run starts. A move with none of these keeps
 * the brief's own desk.
 */

/** "LOCATION · East Nashville block": a desk named in front of the label, and its separator ("Audience-first" is no prefix). */
const DESK_PREFIX = /^\s*(investment|location|marketing|audience)\s*(?:[·:|–—]|\s-)\s*/i;

/** Words that place a question on a desk, strongest desks first: a block or a site is a location question even when it names an audience. */
const DESK_WORDS: ReadonlyArray<{ pillar: Pillar; words: RegExp }> = [
  {
    pillar: "location",
    // Whole words only: "streetwear", "cornerstone" and "zipper" are not places.
    words: /\b(?:blocks?|neighbou?rhoods?|storefronts?|sites?|tenants?|venues?|corners?|streets?|zip(?: codes?)?|pop-?ups?|lift map|white space|where (?:should|to|in) .*\bopen|open (?:a|an|the|my))\b/i,
  },
  {
    pillar: "marketing",
    words: /\b(sponsors?|sponsorships?|tours?|touring|launch(?:es|ing)?|markets?|cities|campaigns?|partners?|partnerships?|activations?)\b/i,
  },
  {
    pillar: "investment",
    words: /\b(compet(?:e|es|itors?|ition)|rivals?|vs\.?|versus|head to head|moat|niche|substitut\w*|momentum|position|brand health|who wins|peers?)\b/i,
  },
  {
    pillar: "audience",
    words: /\b(audiences?|who (?:is|are)|fans|listeners|shoppers|customers|what else (?:do|does) (?:they|their)|cultural (?:neighbou?rhood|home))\b/i,
  },
];

/** The desk a next move lands on: its compiled command's, else its label's desk prefix, else its label's words, else its question's, else the brief's own. */
export function nextMoveDesk(move: { label: string; question: string }, fallback: Pillar): Pillar {
  const command = parseCommand(move.question);
  if (command) return command.pillar;
  const named = DESK_PREFIX.exec(move.label)?.[1]?.toLowerCase();
  if (named !== undefined && (PILLAR_VALUES as readonly string[]).includes(named)) return named as Pillar;
  for (const text of [move.label, move.question]) {
    const hit = DESK_WORDS.find((d) => d.words.test(text));
    if (hit) return hit.pillar;
  }
  return fallback;
}

/** The chip's words: the label without its desk prefix, which the chip prints on its own. */
export function nextMoveLabel(label: string): string {
  const rest = label.replace(DESK_PREFIX, "").trim();
  return rest === "" ? label.trim() : rest;
}

/** "/ask?q=…&parent=<runId>": the Ask page for a follow-up of this brief (the same URL ../../components/ask/ask-href builds). */
export function nextMoveHref(question: string, parentRunId: string): string {
  const params = new URLSearchParams({ q: question });
  if (parentRunId) params.set("parent", parentRunId);
  return `/ask?${params.toString()}`;
}

/** The report's next moves as chips, in order. */
export function buildNextMoves(moves: readonly { label: string; question: string }[], runId: string, pillar: Pillar | null): BriefNextMove[] {
  return moves.map((m) => {
    const desk = nextMoveDesk(m, pillar ?? "investment");
    return { label: nextMoveLabel(m.label), question: m.question, pillar: desk, deskLabel: DESK_LABEL[desk], href: nextMoveHref(m.question, runId) };
  });
}
