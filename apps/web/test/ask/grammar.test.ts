// The command grammar (PLAN §8.2): mnemonics compile in the browser; natural language is left to CLERK.
// Invented entities only.
import { compileMnemonic, EMPTY_CANDIDATES, type Intent } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { parseCommand } from "../../lib/grammar/parse";

describe("parseCommand", () => {
  it.each([
    ["Juniper Cola HLTH", "brand_health", "investment", "JUNIPER COLA <BRAND> HLTH"],
    ["JUNIPER COLA <BRAND> HLTH", "brand_health", "investment", "JUNIPER COLA <BRAND> HLTH"],
    ["Brand Alpha VS Brand Beta", "head_to_head", "investment", "BRAND ALPHA VS BRAND BETA"],
    ["BRAND ALPHA VS. BRAND BETA", "head_to_head", "investment", "BRAND ALPHA VS BRAND BETA"],
    ["Riverside, Austin DNA", "area_profile", "location", "RIVERSIDE, AUSTIN DNA"],
    ["East Side,Nashville TEN", "tenant_mix", "location", "EAST SIDE, NASHVILLE TEN"],
    ["natural-wine bar SITE Austin", "site_selection", "location", "NATURAL-WINE BAR SITE AUSTIN"],
    ["Artist Nova SPON", "sponsorship", "marketing", "ARTIST NOVA <ARTIST> SPON"],
    ["Comedian Vega <PERSON> MKTS", "market_selection", "marketing", "COMEDIAN VEGA <PERSON> MKTS"],
    ["Comedian Vega MKTS", "market_selection", "marketing", "COMEDIAN VEGA MKTS"],
    ["Brand Gamma AUD", "audience_discovery", "audience", "BRAND GAMMA AUD"],
    ["  Brand   Gamma    AUD  ", "audience_discovery", "audience", "BRAND GAMMA AUD"],
    ["Juniper Cola COLLAB", "brand_collab", "marketing", "JUNIPER COLA <BRAND> COLLAB"],
    ["Juniper Cola CRTR", "creator_fit", "marketing", "JUNIPER COLA <BRAND> CRTR"],
    ["small-batch hot sauce LNCH", "launch_test", "investment", "SMALL-BATCH HOT SAUCE LNCH"],
    ["Riverside, Austin TWIN Denver", "taste_twins", "location", "RIVERSIDE, AUSTIN TWIN DENVER"],
    ["Austin VS Denver CITY", "city_compare", "location", "AUSTIN VS DENVER CITY"],
    ["Austin VS Denver VS Nashville CITY natural-wine bar", "city_compare", "location", "AUSTIN VS DENVER VS NASHVILLE CITY NATURAL-WINE BAR"],
    ["KANSAS CITY VS Denver CITY", "city_compare", "location", "KANSAS_CITY VS DENVER CITY"],
  ])("compiles %s", (input, job, pillar, mnemonic) => {
    expect(parseCommand(input)).toMatchObject({ job, pillar, mnemonic });
  });

  it("reads the names, places and concept of each form", () => {
    expect(parseCommand("Brand Alpha VS Brand Beta")?.names).toEqual([
      { text: "Brand Alpha", type: "brand" },
      { text: "Brand Beta", type: "brand" },
    ]);
    expect(parseCommand("Riverside, Austin DNA")).toMatchObject({ names: [], area: "Riverside", city: "Austin", concept: null });
    expect(parseCommand("ramen counter SITE Nashville")).toMatchObject({ concept: "ramen counter", city: "Nashville", area: null });
    expect(parseCommand("Juniper Cola <brand> HLTH")?.names).toEqual([{ text: "Juniper Cola", type: "brand" }]);
    expect(parseCommand("Comedian Vega MKTS")?.names).toEqual([{ text: "Comedian Vega", type: null }]);
    expect(parseCommand("Riverside, Austin TWIN Denver")).toMatchObject({ names: [], area: "Riverside", city: "Austin", targetCity: "Denver" });
    expect(parseCommand("Austin VS Denver CITY wine bar")).toMatchObject({ cities: ["Austin", "Denver"], concept: "wine bar", city: "Austin" });
    expect(parseCommand("hot sauce LNCH")).toMatchObject({ concept: "hot sauce", names: [] });
  });

  it("prints what code compiles for the same reading (compileMnemonic)", () => {
    const intent = (over: Partial<Intent>): Intent => ({
      pillar: "investment",
      job: "brand_health",
      mentions: [],
      geo: { metro: null, area: null, unsupported_place: null, market: null, target_metro: null, cities: [] },
      constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [], concept_description: null },
      safety: { allowed: true, category: null, reframe: null },
      read_as: { nearest: false, not_covered: [] },
      assumptions: [],
      mnemonic: "",
      candidates: EMPTY_CANDIDATES,
      ...over,
    });
    const brand = (text: string, role: "primary" | "peer") => ({ text, entity_type: "brand" as const, role, public_figure: false });
    expect(parseCommand("Juniper Cola HLTH")?.mnemonic).toBe(compileMnemonic(intent({ mentions: [brand("Juniper Cola", "primary")] })));
    expect(parseCommand("Brand Alpha VS Brand Beta")?.mnemonic).toBe(
      compileMnemonic(intent({ job: "head_to_head", mentions: [brand("Brand Alpha", "primary"), brand("Brand Beta", "peer")] })),
    );
    expect(parseCommand("Riverside, Austin TEN")?.mnemonic).toBe(
      compileMnemonic(intent({ job: "tenant_mix", geo: { metro: "austin", area: "Riverside", unsupported_place: null, market: null, target_metro: null, cities: [] } })),
    );
    expect(parseCommand("juniper bar SITE Austin")?.mnemonic).toBe(
      compileMnemonic(
        intent({
          job: "site_selection",
          geo: { metro: "austin", area: null, unsupported_place: null, market: null, target_metro: null, cities: [] },
          constraints: { concepts: ["juniper bar"], sponsor_categories: [], domains: [], ages: [], notes: [], concept_description: null },
        }),
      ),
    );
    const geo = { metro: null, area: null, unsupported_place: null, market: null, target_metro: null, cities: [] };
    const constraints = { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [], concept_description: null };
    expect(parseCommand("Riverside, Austin TWIN Denver")?.mnemonic).toBe(
      compileMnemonic(intent({ job: "taste_twins", geo: { ...geo, metro: "austin", area: "Riverside", target_metro: "denver" } })),
    );
    expect(parseCommand("Austin VS Kansas City CITY wine bar")?.mnemonic).toBe(
      compileMnemonic(intent({ job: "city_compare", geo: { ...geo, cities: ["austin", "kansas_city"] }, constraints: { ...constraints, concepts: ["wine bar"] } })),
    );
    expect(parseCommand("hot sauce LNCH")?.mnemonic).toBe(compileMnemonic(intent({ job: "launch_test", constraints: { ...constraints, concepts: ["hot sauce"] } })));
    expect(parseCommand("Juniper Cola COLLAB")?.mnemonic).toBe(compileMnemonic(intent({ job: "brand_collab", mentions: [brand("Juniper Cola", "primary")] })));
  });

  it.each([
    [""],
    ["   "],
    ["Who really competes with Juniper Cola?"],
    ["Juniper Cola vs Brand Beta: who wins where?"],
    ["Is Brand Alpha's audience a moat or a niche?"],
    // Keywords are capitals only: a sentence ending in "site" or "ten", or comparing in passing, is no command.
    ["Brand Alpha hlth"],
    ["Brand Alpha vs Brand Beta"],
    ["How is Juniper Cola doing vs its peers"],
    ["Compare Juniper Cola vs Brand Beta"],
    ["the best web site design"],
    ["Riverside, Austin dna"],
    ["Brand Alpha VS Brand Beta VS Brand Gamma"],
    ["Brand Alpha VS"],
    ["HLTH"],
    ["Juniper Cola <SODA> HLTH"],
    ["Juniper, Cola HLTH"],
    ["A, B, C DNA"],
    [`${"x".repeat(81)} HLTH`],
    // The placeholders of a compiled command are never names: "VS <B>" is no command.
    ["<A> VS <B>"],
    ["JUNIPER COLA VS <B>"],
    ["<NAME> HLTH"],
    ["JUNIPER COLA <NAME> HLTH"],
    ["<AREA>, <CITY> DNA"],
    ["RIVERSIDE, <CITY> TEN"],
    ["<CONCEPT> SITE <CITY>"],
    ["RAMEN COUNTER SITE <CITY>"],
    ["<CITY> VS <CITY> CITY"],
    ["Austin VS <CITY> CITY"],
    ["A VS B VS C VS D VS E CITY"],
    ["Austin CITY"],
    ["<CONCEPT> LNCH"],
    ["RIVERSIDE, AUSTIN TWIN <CITY>"],
  ])("leaves %j to CLERK", (input) => {
    expect(parseCommand(input)).toBeNull();
  });
});
