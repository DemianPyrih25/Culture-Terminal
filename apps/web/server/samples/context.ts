import { AiContextBlock, WebContextBlock } from "@ct/contracts";

/**
 * Invented "What AI knows (not verified)" and "From the web" blocks (R4, R5) for test runs and the synthetic
 * samples: the sample brand (Juniper Cola) is invented, every link is on a reserved .test domain (RFC 6761, never a real site; the page shows no "example" wording), and no model or search
 * was called, so the blocks name no model and cost nothing. They let the live page, the permalink and the
 * replay player show both cards without a key. The AI block keeps the no-number rule like a real one.
 * Not server-only on purpose: tools/dev/sample-run.ts writes the same blocks into the sample files.
 */

/** The AI block of the synthetic brand-health run, at `at` (ISO). */
export function sampleAiContext(at: string): AiContextBlock {
  return AiContextBlock.parse({
    status: "ok",
    items: [
      { topic: "Ownership", text: "Juniper Cola is described as an independent, founder-led soda maker.", kind: "deal" },
      { topic: "Where it sells", text: "It is said to sell mainly through regional grocers and cafes in the South.", kind: "footprint" },
      { topic: "Brand safety", text: "No widely reported controversy is known for this brand.", kind: "risk" },
    ],
    presenceMarkets: ["nashville"],
    model: null,
    generatedAt: at,
    cached: false,
    note: null,
    droppedForNumbers: 0,
  });
}

/** The web block of the synthetic brand-health run, at `at` (ISO). */
export function sampleWebContext(at: string): WebContextBlock {
  return WebContextBlock.parse({
    status: "ok",
    items: [
      {
        claim: "Juniper Cola opened a tasting room in Nashville, according to a local food site.",
        url: "https://news.invented-site.test/juniper-cola-tasting-room",
        title: "Juniper Cola opens a tasting room (invented test page)",
        publisher: "news.invented-site.test",
        published: null,
        publishedIso: null,
        retrievedAt: at,
        citedText: "Juniper Cola opened a tasting room in Nashville",
      },
      {
        claim: "The brand added a lower-sugar cola to its line, a trade newsletter reported.",
        url: "https://trade.invented-site.test/juniper-cola-new-line",
        title: "A new cola from Juniper (invented test page)",
        publisher: "trade.invented-site.test",
        published: "April 30, 2025",
        publishedIso: "2025-04-30",
        retrievedAt: at,
        citedText: "Juniper Cola added a lower-sugar cola to its line",
      },
    ],
    model: null,
    searches: 0,
    retrievedAt: at,
    cached: false,
    note: null,
    droppedForNumbers: 0,
  });
}
