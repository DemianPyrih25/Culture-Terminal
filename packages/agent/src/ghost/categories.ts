import { JOB_MNEMONIC, JOB_PILLAR, PILLAR_LABEL, type GeoApi, type GhostPickCategory, type Intent, type Job, type MetroId } from "@ct/contracts";
import { sanitizeQuestion, wrapQuestion } from "../llm/question";
import { listedAreas } from "../run/areas";
import { gazetteer } from "../run/gazetteer";
import type { RunMarket } from "../run/markets";

/**
 * The pick lists each job fills (SPEC §6.6, §7.2): the names its deliverable is about, so GHOST
 * ranks the same kind of thing the brief ranks. ghost.md says what each list holds; this table says
 * which lists a job fills, and buildGhostDiff compares only these with the brief. tidyGhostAnswer
 * empties every other list, so a name GHOST puts in one is never looked up, diffed or counted.
 */
export const GHOST_JOB_CATEGORIES: Readonly<Record<Job, readonly GhostPickCategory[]>> = {
  // The closest substitutes, and the metros where the brand's taste is strongest.
  brand_health: ["competitors", "markets"],
  // "Same customer?" is the substitute ranking; "who wins where" is the market ranking.
  head_to_head: ["competitors", "markets"],
  site_selection: ["neighbourhoods"],
  // The brands that fit the area: its tenant fit and local brands.
  area_profile: ["tenants"],
  tenant_mix: ["tenants"],
  sponsorship: ["partners"],
  market_selection: ["markets"],
  // What else the audience loves, on the brand side: the partners a marketer would reach it through.
  audience_discovery: ["partners"],
  // The areas of the target city that twin the source area.
  taste_twins: ["neighbourhoods"],
  brand_collab: ["partners"],
  creator_fit: ["creators"],
  // The partners a new concept should launch with (its kept and added analogs).
  launch_test: ["partners"],
  // The cities compared, ranked.
  city_compare: ["markets"],
};

/**
 * The map city whose areas GHOST is shown and its neighbourhood picks are matched in (GhostContext.metro,
 * GhostForRunOptions.metro): the question's metro, except for taste_twins, whose twins are areas of
 * the target city.
 */
export function ghostMetroOf(intent: Pick<Intent, "job" | "geo">): MetroId | null {
  return intent.job === "taste_twins" ? (intent.geo.target_metro ?? intent.geo.metro) : intent.geo.metro;
}

/** Angle brackets escaped, as run/context.ts escapes untrusted text, so no line can open or close a tag. */
const escapeAngles = (s: string): string => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** At most this many earlier questions of a chain go in the message, the latest ones. */
export const GHOST_EARLIER_MAX = 5;

/**
 * What GHOST's message lists beside the question, all of it written by code. The places are the
 * vocabulary the ANALYST's run context gives it (MARKETS, AREAS): config and gazetteer data, not
 * Qloo data and not a tool (D23), so GHOST names places the brief can rank. Earlier questions stand
 * in for the ANALYST's CASE SUMMARY without its findings, which carry the parent's Qloo metrics.
 */
export interface GhostContext {
  /** The markets the brief can rank (the run's MARKETS; GHOST_MARKETS for a finished run): listed when the job fills markets. */
  markets?: readonly RunMarket[];
  /** The question's gazetteer metro: its areas are listed when the job fills neighbourhoods. */
  metro?: MetroId | null;
  /** Where the areas come from; the shared gazetteer by default. */
  geo?: Pick<GeoApi, "neighbourhoods">;
  /** The questions asked before this one in the same chain, oldest first; never their answers. */
  earlier?: readonly string[];
}

/**
 * GHOST's only user message: the DESK and JOB lines the ANALYST's run context opens with
 * (run/context.ts), the lists this job fills, the places those lists choose from, the chain's earlier
 * questions, then the question wrapped exactly as for the ANALYST. GHOST sees nothing from Qloo, the
 * registry or the CLERK. Every user-written line is sanitized onto one line and its angle brackets
 * escaped, so it can never pass for a code-written line or open a tag.
 */
export function ghostUserMessage(question: string, job: Job, context: GhostContext = {}): string {
  const lists = GHOST_JOB_CATEGORIES[job];
  const lines = [
    `DESK: ${PILLAR_LABEL[JOB_PILLAR[job]]}`,
    `JOB: ${job} (${JOB_MNEMONIC[job]})`,
    `LISTS: ${lists.join(", ")}; leave the other lists empty.`,
  ];
  const markets = context.markets ?? [];
  if (lists.includes("markets") && markets.length > 0) {
    lines.push(`MARKETS: ${markets.map((m) => escapeAngles(`${m.label}, ${m.state}`)).join("; ")}`);
  }
  const metro = context.metro ?? null;
  if (lists.includes("neighbourhoods") && metro !== null) {
    // A large county lists the AREAS_MAX areas nearest its centre, as the ANALYST's AREAS does.
    const areas = listedAreas(context.geo ?? gazetteer(), metro);
    if (areas.length > 0) lines.push(`AREAS (${metro}): ${areas.map((a) => escapeAngles(a.name)).join("; ")}`);
  }
  const earlier = (context.earlier ?? []).map((q) => escapeAngles(sanitizeQuestion(q))).filter((q) => q !== "");
  if (earlier.length > 0) {
    lines.push(`EARLIER QUESTIONS (oldest first):\n${earlier.slice(-GHOST_EARLIER_MAX).map((q) => `- ${q}`).join("\n")}`);
  }
  return [...lines, wrapQuestion(question)].join("\n\n");
}
