import type { Pillar } from "@ct/contracts";

/**
 * The A/Starter columns of Home (A01): a few questions per desk. Each starter shows a short label and
 * asks the full question. The showcase questions come word for word from config/showcases.json (a
 * test keeps them in step), so they meet the stored showcase runs and the answer cache; the others are
 * written in the same voice. Real names appear only as question text, as in showcases.json.
 */

export interface Starter {
  /** What the column shows. */
  label: string;
  /** What the Ask page asks. */
  question: string;
  /** The showcase it opens (config/showcases.json code), if any. */
  showcase?: string;
}

export interface StarterDesk {
  pillar: Pillar;
  starters: readonly Starter[];
}

export const STARTER_DESKS: readonly StarterDesk[] = [
  {
    pillar: "investment",
    starters: [
      {
        label: "Liquid Death: moat or niche?",
        question: "Liquid Death: is its audience a moat or a niche? Who does it really compete with?",
        showcase: "S1",
      },
      {
        label: "Olipop vs Poppi: who wins?",
        question: "Olipop vs Poppi: are they fighting for the same customer, and where does each win?",
        showcase: "S2",
      },
      {
        label: "Who really rivals Red Bull?",
        question: "Red Bull: who does it really compete with for its audience, and is that audience a moat?",
      },
      {
        label: "Celsius vs Red Bull, by city",
        question: "Celsius vs Red Bull: are they fighting for the same customer, and which metros does each win?",
      },
    ],
  },
  {
    pillar: "location",
    starters: [
      {
        label: "Best tenant for a vacant corner?",
        question:
          "I own a vacant corner storefront in East Nashville. What should go there, and what does the block already have too much of?",
        showcase: "S3",
      },
      {
        label: "Where to open a listening bar?",
        question: "Where in Austin should I open a natural-wine and vinyl listening bar?",
        showcase: "S4",
      },
      {
        label: "Who is here in East Nashville?",
        question: "What is East Nashville's taste profile, and how does it differ from the rest of Nashville?",
      },
      {
        label: "Where to open a ramen counter?",
        question: "Where in Nashville should I open a late-night ramen counter?",
      },
    ],
  },
  {
    pillar: "marketing",
    starters: [
      {
        label: "Which brands fit Zach Bryan?",
        question:
          "Zach Bryan is planning a stadium tour. Which brand is the best sponsor in each category, which fits are under the radar, and which tour markets fit each?",
        showcase: "S5",
      },
      {
        label: "Best markets for Nate Bargatze?",
        question: "Nate Bargatze wants eight secondary-market dates. Where does his audience out-index other comedians?",
        showcase: "S6",
      },
      {
        label: "Where should Zach Bryan tour?",
        question: "Zach Bryan wants ten more arena dates. Which markets does his audience out-index other country artists in?",
      },
    ],
  },
  {
    pillar: "audience",
    starters: [
      {
        label: "Who shops at Trader Joe's?",
        question: "Who is the Trader Joe's audience, and what music, podcasts and brands do they over-index on?",
        showcase: "S7",
      },
      {
        label: "Who drinks Liquid Death?",
        question: "Who is the Liquid Death audience, and what music, podcasts and TV do they over-index on?",
      },
      {
        label: "What do Olipop fans listen to?",
        question: "Who is the Olipop audience, and which artists and podcasts do they over-index on?",
      },
    ],
  },
];
