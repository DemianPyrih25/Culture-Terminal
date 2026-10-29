// LLM alone vs Culture Terminal (SPEC §6.6): the GHOST view model and the invented GHOST samples of the
// /dev/brief viewer (D29). The answer page's "AI alone" card is covered in test/answer.
import { describe, expect, it, vi } from "vitest";
import { GHOST_HONESTY_LINE, RunEvent, type GhostAnswer, type GhostDiff } from "@ct/contracts";
import { GHOST_SAMPLES, ghostRunEvents, withGhost } from "../../app/dev/brief/ghost-runs";
import { buildGhostView, ghostOf, markClaims, type GhostRun } from "../../lib/brief";
import { stateOf } from "./support";

vi.mock("server-only", () => ({}));

const NO_PICKS: GhostAnswer["picks"] = { competitors: [], markets: [], neighbourhoods: [], tenants: [], partners: [], creators: [] };

function ghostRun(answer: Partial<GhostAnswer> = {}, diff: Partial<GhostDiff> = {}): GhostRun {
  return {
    answer: { headline: "Invented headline.", picks: NO_PICKS, numeric_claims: [], ...answer },
    diff: {
      items: [],
      overlapAt5: null,
      resolvability: null,
      unsourcedNumericClaims: 0,
      meanPopularity: { ghost: null, qloo: null },
      honestyLine: GHOST_HONESTY_LINE,
      ...diff,
    },
  };
}


describe("the GHOST view", () => {
  it("is null without a GHOST, and reads the event's before the report's", () => {
    expect(buildGhostView(null)).toBeNull();
    const fromEvent = ghostRun({ headline: "From the event." });
    const fromReport = ghostRun({ headline: "From the report." });
    expect(ghostOf({ ghost: fromEvent, report: { ghost: fromReport } })).toBe(fromEvent);
    expect(ghostOf({ ghost: null, report: { ghost: fromReport } })).toBe(fromReport);
    expect(ghostOf({})).toBeNull();
  });

  it("marks every name ✓ both, ★ found only by Qloo or ✗ LLM only, with whether an LLM-only name resolves", () => {
    const view = buildGhostView(GHOST_SAMPLES.sponsorship ?? null);
    const partners = view?.categories.find((c) => c.category === "partners");
    expect(view?.categories.map((c) => c.category)).toEqual(["partners"]);
    // GHOST's column in its own order; the brief's in the diff's.
    expect(partners?.ghost.map((n) => [n.name, n.mark, n.word, n.resolvesText])).toEqual([
      ["Voltline Energy", "✓", "Found by both", null],
      ["Granite Peak Light", "✗", "LLM only", "resolves in Qloo: yes"],
      ["Mesa Line Trucks", "✓", "Found by both", null],
      ["Bluebonnet Boot Co.", "✗", "LLM only", "resolves in Qloo: no"],
      ["Summit Rush Cola", "✗", "LLM only", "resolves in Qloo: yes"],
    ]);
    expect(partners?.qloo.map((n) => [n.name, n.mark])).toEqual([
      ["Harrow Pale Lager", "★"],
      ["Cinder Hollow Rye", "★"],
      ["Mesa Line Trucks", "✓"],
      ["Lantern & Loom", "★"],
      ["Ridgeway Outdoor", "★"],
      ["Voltline Energy", "✓"],
    ]);
    expect(partners?.qloo.every((n) => n.resolves === null && n.resolvesText === null)).toBe(true);
    expect(partners?.tally).toBe("2 both · 4 only Qloo · 3 LLM only");
  });

  it("shows each pick once, under GHOST's spelling, even where the diff holds Qloo's", () => {
    const view = buildGhostView(
      ghostRun(
        { picks: { ...NO_PICKS, partners: ["Voltline", "Granite Peak Light"] } },
        {
          items: [
            { name: "Voltline Energy", category: "partners", status: "both", resolvesInQloo: null, ref: "R1" },
            { name: "Granite Peak Light", category: "partners", status: "llm_only", resolvesInQloo: true, ref: null },
          ],
        },
      ),
    );
    const partners = view?.categories[0];
    expect(partners?.ghost.map((n) => [n.name, n.status, n.resolvesText])).toEqual([
      ["Voltline", "both", null],
      ["Granite Peak Light", "llm_only", "resolves in Qloo: yes"],
    ]);
    expect(partners?.qloo.map((n) => [n.name, n.status])).toEqual([["Voltline Energy", "both"]]);
    expect(partners?.tally).toBe("1 both · 1 LLM only");
  });

  it("pairs a pick by its spelling first, else with the next diff item left, and keeps a pick with none as not checked", () => {
    const view = buildGhostView(
      ghostRun(
        { picks: { ...NO_PICKS, tenants: ["Moth and Mallow", "Larkspur  Bakery!", "Quillfeather Books", "Wrenfield Cider"] } },
        {
          items: [
            { name: "Larkspur Bakery", category: "tenants", status: "both", resolvesInQloo: null, ref: "R4" },
            { name: "Quillfeather Books", category: "tenants", status: "llm_only", resolvesInQloo: false, ref: null },
            { name: "Moth & Mallow Co.", category: "tenants", status: "both", resolvesInQloo: null, ref: "R5" },
          ],
        },
      ),
    );
    const tenants = view?.categories[0];
    expect(tenants?.ghost.map((n) => [n.name, n.status, n.resolvesText])).toEqual([
      ["Moth and Mallow", "both", null],
      ["Larkspur  Bakery!", "both", null],
      ["Quillfeather Books", "llm_only", "resolves in Qloo: no"],
      ["Wrenfield Cider", "llm_only", "resolves in Qloo: not checked"],
    ]);
    expect(tenants?.qloo.map((n) => n.name)).toEqual(["Larkspur Bakery", "Moth & Mallow Co."]);
    expect(tenants?.tally).toBe("2 both · 2 LLM only");
    // A diff item with no pick left to take it still shows, after GHOST's own names.
    const extra = buildGhostView(
      ghostRun(
        { picks: { ...NO_PICKS, tenants: ["Larkspur Bakery"] } },
        {
          items: [
            { name: "Larkspur Bakery", category: "tenants", status: "both", resolvesInQloo: null, ref: "R4" },
            { name: "Copperkettle Tea", category: "tenants", status: "llm_only", resolvesInQloo: true, ref: null },
          ],
        },
      ),
    );
    expect(extra?.categories[0]?.ghost.map((n) => [n.name, n.status, n.resolvesText])).toEqual([
      ["Larkspur Bakery", "both", null],
      ["Copperkettle Tea", "llm_only", "resolves in Qloo: yes"],
    ]);
  });

  it("prints the header figures with what each means, and \"Not measured\" for one the diff did not measure", () => {
    const view = buildGhostView(GHOST_SAMPLES.sponsorship ?? null);
    expect(view?.figures.map((f) => [f.key, f.value, f.comparator])).toEqual([
      ["overlap", "20%", null],
      ["resolvability", "80%", null],
      ["unsourced", "3", null],
      ["popularity", "78th", "vs 52nd · this brief"],
    ]);
    for (const f of view?.figures ?? []) expect(f.meaning.length).toBeGreaterThan(10);
    const empty = buildGhostView(ghostRun());
    expect(empty?.figures.map((f) => [f.key, f.value, f.measured])).toEqual([
      ["overlap", "Not measured", false],
      ["resolvability", "Not measured", false],
      ["unsourced", "0", true],
      ["popularity", "Not measured", false],
    ]);
    expect(empty?.figures.find((f) => f.key === "unsourced")?.meaning).toBe("GHOST stated no numbers");
    expect(empty?.categories).toEqual([]);
  });

  it("underlines each claim where it stands in the headline, whole, never inside a longer number", () => {
    expect(markClaims("About 70% of fans, not 170%, see 3 shows.", ["70%", "3"])).toEqual([
      { text: "About ", claim: false },
      { text: "70%", claim: true },
      { text: " of fans, not 170%, see ", claim: false },
      { text: "3", claim: true },
      { text: " shows.", claim: false },
    ]);
    // The longer claim wins where two overlap; a claim the headline does not hold marks nothing.
    expect(markClaims("Reach 1.5 million.", ["1.5", "1.5 million", "42"]).filter((p) => p.claim)).toEqual([{ text: "1.5 million", claim: true }]);
    expect(markClaims("No numbers here.", [])).toEqual([{ text: "No numbers here.", claim: false }]);
  });
});

describe("the dev GHOST samples", () => {
  it("add a ghost event before run.end and the GHOST to the report, and pass the RunEvent schema", () => {
    for (const job of ["sponsorship", "brand_health"] as const) {
      const list = ghostRunEvents(job) ?? [];
      expect(RunEvent.array().safeParse(list).success).toBe(true);
      expect(list.map((e) => e.seq)).toEqual(list.map((_, i) => i + 1));
      expect(list.at(-1)?.type).toBe("run.end");
      expect(list.at(-2)?.type).toBe("ghost");
      const state = stateOf(list);
      expect(state.ghost).toEqual(GHOST_SAMPLES[job]);
      expect(state.report?.ghost).toEqual(GHOST_SAMPLES[job]);
      expect(state.report?.receipt.models.ghost).toBe("claude-sonnet-5-5");
    }
    expect(ghostRunEvents("site_selection")).toBeNull();
    expect(withGhost([], GHOST_SAMPLES.sponsorship ?? (null as never))).toEqual([]);
  });
});
