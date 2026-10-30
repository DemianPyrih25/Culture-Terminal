/**
 * CHECKER V4: the phrase linter (SPEC §6.2). Each rule names what the phrase does wrong, so the
 * repair message can say how to rewrite it. Advice rules also feed the `adviceTerms` count on the
 * validation event.
 */

export interface PhraseRule {
  id: string;
  re: RegExp;
  /** Investment-advice vocabulary (D8). */
  advice: boolean;
  /** How to rewrite, for the repair turn. */
  hint: string;
}

export const PHRASE_RULES: readonly PhraseRule[] = [
  {
    id: "trade_advice",
    re: /\b(?:you|we)\s+should\s+(?:buy|sell|short)\b/i,
    advice: true,
    hint: "no buy, sell or short advice; describe the taste signal",
  },
  { id: "invest_call", re: /\binvest\s+(?:now|in)\b/i, advice: true, hint: "no investment calls" },
  { id: "price_target", re: /\bprice\s+targets?\b/i, advice: true, hint: "no price targets" },
  {
    id: "valuation",
    re: /\b(?:undervalued|overvalued|underpriced|overpriced|cheaper)\b|\bcosts?\s+less\b/i,
    advice: true,
    hint: "no valuation, pricing or cost claims; there is no price or fee data (UNDER-THE-RADAR is fit minus popularity, not a lower cost)",
  },
  {
    id: "certainty",
    re: /\bguaranteed\b|\bwill\s+(?:definitely|certainly)\b/i,
    advice: false,
    hint: "no certainty claims; state what the data shows",
  },
  {
    id: "population_share",
    re: /(?:\d+(?:\.\d+)?\s?%|\{\{M[1-9]\d*\}\}\s?%?)\s+of\s+(?:all\s+)?(?:customers|fans|people|residents|consumers|shoppers|users|listeners|viewers)\b/i,
    advice: false,
    hint: "affinity is not a share of people; describe group-level taste",
  },
  {
    // "cause" as a verb, or named as the cause; the noun in a hedge ("the root cause is unclear",
    // "cause for caution") claims nothing.
    id: "causal",
    re: /\bcaus(?:es|ed|ing)\b|\bcause(?=\s+(?!for\b|of\b|is\b|was\b|remains\b)[a-z])|\b(?:is|was|are)\s+the\s+(?:main\s+|primary\s+|key\s+)?cause\b|\b(?:drive|drives|drove|driving)\s+sales\b/i,
    advice: false,
    hint: "no causal claims; affinity is not sales or causation",
  },
  {
    id: "collapse",
    re: /\bcollaps(?:e|es|ed|ing)\b|\bbankrupt(?:cy|cies)?\b/i,
    advice: false,
    hint: "no collapse or bankruptcy language",
  },
  {
    id: "individual",
    re: /\b(?:this|that)\s+(?:person|individual)\b|\b(?:residents|individuals)\s+who\b/i,
    advice: false,
    hint: "no individual framing; Qloo signals are aggregated group-level taste",
  },
  {
    id: "poaching",
    re: /\bpoach(?:es|ed|ing)?\b/i,
    advice: false,
    hint: "similarity is symmetric: say near-substitutes, never poaching",
  },
];

export interface PhraseHit {
  rule: PhraseRule;
  /** The matched text, as written. */
  phrase: string;
}

/** Every banned phrase in `text`, in rule order. Tokens are left in place: no rule matches inside one. */
export function phraseHits(text: string): PhraseHit[] {
  return PHRASE_RULES.flatMap((rule) =>
    [...text.matchAll(new RegExp(rule.re.source, "gi"))].map((m) => ({ rule, phrase: m[0] })),
  );
}
