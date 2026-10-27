import type { IconName } from "../components/ui/icons";

/**
 * The copy of /how-it-works (N15): how an answer is made, how to read one, what we don't do, coverage,
 * and the data and models behind it. Static, apart from the trend window the page passes in.
 */

export const HOW_PAGE = {
  metaTitle: "How it works · Culture Terminal",
  metaDescription:
    "How Culture Terminal answers: plain-English questions, Qloo taste data, every number computed in code and checked before you see it.",
  title: "How it works",
  lead: "Ask in plain English. We pull taste data from Qloo, compute every number in code, check each one, and write a one-page answer.",
  analystsLink: "For analysts: every formula and rule",
  ask: "Ask a question",
} as const;

export interface HowStep {
  icon: IconName;
  title: string;
  text: string;
}

export const HOW_STEPS: readonly HowStep[] = [
  {
    icon: "message-square-text",
    title: "You ask",
    text: "Type a business question about a brand, artist, place or audience. We match every name to Qloo's catalogue. If a name could mean two things, you pick.",
  },
  {
    icon: "database",
    title: "We measure",
    text: "Before looking, the AI writes down what it expects. Then our code queries Qloo and calculates every figure. The AI never types a number.",
  },
  {
    icon: "shield-check",
    title: "We check",
    text: "Before you see the answer, every number is traced to its Qloo source and advice wording is blocked. Click Source on any number to see it.",
  },
];

export const READING_TITLE = "Reading an answer";

/** The bullets of "Reading an answer"; the trend window comes from the code (trendWindowText). */
export function readingBullets(trendWindow: string): string[] {
  return [
    "Confidence (High, Medium, Low) rates how complete and fresh the data was, not how likely the answer is to be right. Fixed rules set it; the AI can't.",
    "Affinity means shared taste. It is not sales, market share or cause.",
    `Trend figures come from Qloo's latest trend window, ${trendWindow}.`,
    "Missing data says No data, never zero.",
  ];
}

export const DONT_TITLE = "What we don't do";

export const DONT_BULLETS: readonly string[] = [
  "No individuals: group-level taste only.",
  "No politics, religion, health, ethnicity or other sensitive traits.",
  "No decisions about housing, credit, jobs or insurance.",
  "No buy, sell or price advice.",
];

export const DONT_CLOSING = "We decline these before any data is fetched and suggest a question we can answer.";

export const HOW_NOTES: readonly { title: string; text: string }[] = [
  {
    title: "Coverage",
    text: "Place questions cover neighbourhoods in 13 US cities: Atlanta, Austin, Boston, Chicago, Dallas, Denver, Houston, Los Angeles, Miami, Nashville, New York City, San Francisco and Seattle. Markets cover 51 US cities. Trends cover brands and TV shows. Profiles cover brands, artists, public figures, podcasts, TV shows and films.",
  },
  {
    title: "Data and models",
    text: "Taste data: Qloo. Reading questions and writing answers: Claude, by Anthropic. Numbers and checks: our own code. Each answer is dated when it was made.",
  },
];
