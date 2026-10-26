// Invented briefs for the Home, Ask and library tests (D29): names, ids, counts and dates match nothing
// real.
import type { BriefList, BriefSummary } from "../../components/library/briefs-client";

export function brief(over: Partial<BriefSummary> = {}): BriefSummary {
  return {
    runId: "run-brief-0001",
    question: "Juniper Cola vs Brand Beta: who wins where?",
    pillar: "investment",
    job: "head_to_head",
    jobLabel: "Compare two brands",
    status: "completed",
    signal: "mixed",
    tag: null,
    headline: "Same customer, different turf {{M3}}; Brand Beta leads the young {{M5}} [E2], the South is {{M7}}.",
    metrics: {
      M3: { label: "Audience overlap", display: "0.64", badge: "MEASURED" },
      M5: { label: "Under-30 tilt to Brand Beta", display: "+0.12", badge: "DERIVED" },
      M7: { label: "Southern share of taste", display: null, badge: "UNAVAILABLE" },
    },
    confidence: { score: 71, band: "MED" },
    createdAt: "2026-10-14T10:00:00.000Z",
    numbersTraced: { traced: 24, total: 24 },
    sources: 19,
    ...over,
  };
}

export const BRIEFS: readonly BriefSummary[] = [
  brief(),
  brief({
    runId: "run-brief-0002",
    question: "Who really competes with Brand Alpha?",
    job: "brand_health",
    jobLabel: "Real competitors",
    signal: "strong",
    headline: "Brand Alpha is a taste island {{M2}}.",
    metrics: { M2: { label: "Rank in its own row", display: "6 of 6", badge: "MEASURED" } },
    confidence: { score: 68, band: "MED" },
    createdAt: "2026-10-13T10:00:00.000Z",
    sources: 17,
  }),
  brief({
    runId: "run-brief-0003",
    question: "Where in Austin should a juniper bar open?",
    pillar: "location",
    job: "site_selection",
    jobLabel: "Where to open",
    signal: "strong",
    confidence: { score: 74, band: "MED" },
    createdAt: "2025-12-30T10:00:00.000Z",
    sources: 22,
  }),
  brief({
    runId: "run-brief-0004",
    question: "Which brands fit Artist Nova's tour?",
    pillar: "marketing",
    job: "sponsorship",
    jobLabel: "Sponsor fit",
    status: "incomplete",
    signal: null,
    headline: null,
    metrics: {},
    confidence: null,
    numbersTraced: null,
    createdAt: "2026-10-09T10:00:00.000Z",
    sources: 4,
  }),
];

export function briefList(runs: readonly BriefSummary[] = BRIEFS, over: Partial<BriefList> = {}): BriefList {
  return {
    runs: [...runs],
    next: null,
    total: 38,
    pillars: { investment: 14, location: 10, marketing: 8, audience: 6 },
    numbersTraced: { traced: 912, total: 912 },
    pillarsTraced: {
      investment: { traced: 336, total: 336 },
      location: { traced: 240, total: 240 },
      marketing: { traced: 192, total: 192 },
      audience: { traced: 144, total: 144 },
    },
    ...over,
  };
}

export const EMPTY_LIST: BriefList = {
  runs: [],
  next: null,
  total: 0,
  pillars: { investment: 0, location: 0, marketing: 0, audience: 0 },
  numbersTraced: { traced: 0, total: 0 },
  pillarsTraced: {
    investment: { traced: 0, total: 0 },
    location: { traced: 0, total: 0 },
    marketing: { traced: 0, total: 0 },
    audience: { traced: 0, total: 0 },
  },
};
