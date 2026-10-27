import { digestFits, ModelDigest, type QlooApi, type QlooParams, type QlooTagSearchItem } from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import { SKILL_LIMITATIONS } from "../../src/limitations";
import { findTagsSkill, pickTags, planConcept, tagSearchParams, TAG_SEARCH_TAKE } from "../../src/skills/findTags";
import { curatedConcept, curatedConcepts, HEATMAP_BASELINE } from "../../src/skills/findTags/curated";
import { conceptWords, nameMatches, normaliseConcept, tagNameFromUrn, tagTypeOf, tagUse } from "../../src/skills/findTags/tags";
import { BudgetError, fakeProbe, fakeRun, FakeRegistry, FETCHED_AT } from "./support/fakes";

// find_tags runs over a fixture concept map in the pre-Part-8 shape, so the research and unverified
// paths stay under test now that C1 verified a genre tag for every real place type (the real map is
// checked in packages/agent/test/prompts/config.test.ts). Public taxonomy URNs only (D29).
const FIXTURE = vi.hoisted(() => ({
  baseline: { urn: "urn:tag:genre:place:restaurant", status: "verified" },
  categories: [
    {
      key: "restaurant",
      label: "Restaurant",
      aliases: ["restaurant", "eatery", "dining"],
      semantic_query: "restaurant",
      tags: [{ urn: "urn:tag:genre:place:restaurant", status: "verified", verified_as: "heatmap_signal" }],
    },
    {
      key: "cafe",
      label: "Cafe and coffee shop",
      aliases: ["cafe", "coffee shop", "coffee bar", "espresso bar", "run-club coffee bar"],
      semantic_query: "coffee shop",
      tags: [
        { urn: "urn:tag:category:place:cafe", status: "verified", verified_as: "place_filter" },
        { urn: "urn:tag:genre:place:restaurant:coffee_shop", status: "verified", verified_as: "heatmap_signal" },
      ],
    },
    {
      key: "bar",
      label: "Bar",
      aliases: ["bar", "cocktail bar", "pub", "tavern"],
      semantic_query: "bar",
      tags: [{ urn: "urn:tag:genre:place:restaurant:bar", status: "verified", verified_as: "heatmap_signal" }],
    },
    {
      key: "lounge",
      label: "Lounge",
      aliases: ["lounge", "listening lounge", "listening bar"],
      semantic_query: "lounge",
      tags: [{ urn: "urn:tag:genre:place:lounge", status: "research" }],
    },
    {
      key: "wine_bar",
      label: "Wine bar",
      aliases: ["wine bar", "natural-wine bar", "natural wine bar"],
      semantic_query: "natural wine bar",
      tags: [{ urn: "urn:tag:category:place:wine_bar", status: "unverified" }],
    },
    {
      key: "record_store",
      label: "Record store",
      aliases: ["record store", "vinyl shop", "vinyl record store", "record shop"],
      semantic_query: "vinyl record store",
      tags: [{ urn: "urn:tag:category:place:record_store", status: "unverified" }],
    },
    {
      key: "ramen",
      label: "Ramen restaurant",
      aliases: ["ramen", "ramen counter", "ramen shop", "late-night ramen counter"],
      semantic_query: "ramen",
      tags: [{ urn: "urn:tag:category:place:ramen_restaurant", status: "unverified" }],
    },
    {
      key: "live_music_venue",
      label: "Live music venue",
      aliases: ["live music venue", "music venue", "listening room", "concert venue"],
      semantic_query: "live music venue",
      tags: [{ urn: "urn:tag:category:place:live_music_venue", status: "unverified" }],
    },
    {
      key: "bakery",
      label: "Bakery",
      aliases: ["bakery", "pastry shop", "bread bakery"],
      semantic_query: "bakery",
      tags: [{ urn: "urn:tag:category:place:bakery", status: "unverified" }],
    },
    {
      key: "brewery",
      label: "Brewery and taproom",
      aliases: ["brewery", "taproom", "brewpub", "craft beer bar"],
      semantic_query: "brewery taproom",
      tags: [{ urn: "urn:tag:category:place:brewery", status: "unverified" }],
    },
    {
      key: "bookstore",
      label: "Bookstore",
      aliases: ["bookstore", "book shop", "bookshop"],
      semantic_query: "independent bookstore",
      tags: [{ urn: "urn:tag:category:place:book_store", status: "unverified" }],
    },
    {
      key: "pizza",
      label: "Pizzeria",
      aliases: ["pizza", "pizzeria"],
      semantic_query: "pizza",
      tags: [
        { urn: "urn:tag:genre:place:restaurant:pizza", status: "verified", verified_as: "heatmap_signal" },
        { urn: "urn:tag:category:place:pizza_restaurant", status: "unverified", fallback: "semantic_tag_search" },
      ],
    },
    {
      key: "clothing_store",
      label: "Clothing boutique",
      aliases: ["clothing store", "boutique", "vintage clothing", "apparel shop"],
      semantic_query: "clothing boutique",
      tags: [{ urn: "urn:tag:category:place:clothing_store", status: "unverified" }],
    },
  ],
}));
vi.mock("../../../../config/categories.json", () => ({ default: FIXTURE }));

// Invented tag leaves only (D29): the taxonomy namespaces are public, the leaves are made up.
const GENRE_WINE = { id: "urn:tag:genre:place:test_wine_bar", name: "Wine Bar", type: "urn:tag:genre:place" };
const CATEGORY_WINE = { id: "urn:tag:category:place:test_wine_bar", name: "Wine Bar", type: "urn:tag:category:place" };
const GENRE_NATURAL = { id: "urn:tag:genre:place:test_natural_wine_bar", name: "Natural Wine Bar", type: "urn:tag:genre:place" };
const GENRE_LOUNGE = { id: "urn:tag:genre:place:test_lounge", name: "Lounge", type: "urn:tag:genre:place" };
const CUISINE_WINE = { id: "urn:tag:cuisine:qloo:test_natural_wine", name: "Natural Wine", type: "urn:tag:cuisine:qloo" };
const BRAND_KOMBUCHA = { id: "urn:tag:genre:brand:test_kombucha", name: "Kombucha", type: "urn:tag:genre:brand" };
const MUSIC_DREAM_POP = { id: "urn:tag:genre:music:test_dream_pop", name: "Dream Pop", type: "urn:tag:genre:music" };

interface TagCall {
  params: QlooParams;
}

/** A Qloo double that answers /v2/tags only; `budget` calls succeed, then BudgetError (invocation order). */
function tagsQloo(answer: (params: QlooParams) => QlooTagSearchItem[], options: { budget?: number; fail?: (params: QlooParams) => boolean } = {}) {
  const calls: TagCall[] = [];
  let attempts = 0;
  const unused = async (): Promise<never> => {
    throw new Error("unused Qloo endpoint");
  };
  const api: QlooApi = {
    search: unused,
    entities: unused,
    audiences: unused,
    insights: unused,
    trending: unused,
    tags: async (params) => {
      attempts += 1;
      if (options.budget !== undefined && attempts > options.budget) throw new BudgetError("run cap reached");
      calls.push({ params });
      if (options.fail?.(params)) throw Object.assign(new Error("upstream down"), { code: "qloo_unavailable" });
      return {
        data: { results: { tags: answer(params) } },
        meta: {
          qlooCallId: `qc-${calls.length}`,
          requestId: `req-synthetic-${calls.length}`,
          cache: "miss",
          fetchedAt: FETCHED_AT,
          ms: 4,
          stale: false,
          originRunId: null,
        },
      };
    },
  };
  return { api, calls };
}

function input(concepts: { text: string; scope: "place" | "brand" | "media" }[], step: `S${number}` | null = "S1") {
  return findTagsSkill.input.parse({ concepts, trigger_finding_id: null, step_id: step });
}

const WINE_ANSWER = [CUISINE_WINE, GENRE_LOUNGE, CATEGORY_WINE, GENRE_WINE, GENRE_NATURAL];

describe("find_tags: tag vocabulary", () => {
  it("says what a tag can do from its namespace", () => {
    expect(tagUse("urn:tag:genre:place:restaurant:bar")).toBe("heatmap_signal");
    expect(tagUse("urn:tag:category:place:cafe")).toBe("place_filter");
    expect(tagUse("urn:tag:genre:brand:test_snack")).toBe("taste_signal");
    expect(tagUse("urn:tag:cuisine:qloo:test_ramen")).toBe("label_only");
    expect(tagUse("urn:tag:genre:qloo:test_mixed")).toBe("label_only");
  });

  it("derives a tag's type and a readable name from its URN", () => {
    expect(tagTypeOf("urn:tag:genre:place:restaurant:coffee_shop")).toBe("urn:tag:genre:place");
    expect(tagTypeOf("urn:tag:cuisine:qloo:test_ramen")).toBe("urn:tag:cuisine:qloo");
    expect(tagNameFromUrn("urn:tag:genre:place:restaurant:coffee_shop")).toBe("Coffee shop");
  });

  it("normalises concepts and matches names when one holds every word of the other", () => {
    expect(normaliseConcept("  Natural-Wine & Vinyl  Bar ")).toBe("natural wine vinyl bar");
    const query = conceptWords("natural wine bar");
    expect(nameMatches(query, conceptWords("Wine Bar"))).toBe(true);
    expect(nameMatches(query, conceptWords("Natural Wine Bars"))).toBe(true);
    expect(nameMatches(conceptWords("ramen"), conceptWords("Ramen Restaurant"))).toBe(true);
    expect(nameMatches(query, conceptWords("Lounge"))).toBe(false);
    expect(nameMatches(query, conceptWords("Natural Wine Shop"))).toBe(false);
    expect(nameMatches(conceptWords("the"), conceptWords("The"))).toBe(false);
  });
});

describe("find_tags: the curated map", () => {
  it("reads config/categories.json: aliases resolve, unverified tags are never served", () => {
    expect(curatedConcept("Listening Bar")?.key).toBe("lounge");
    expect(curatedConcept("natural-wine bar")?.key).toBe("wine_bar");
    expect(curatedConcept("natural-wine bar")?.served).toEqual([]);
    expect(curatedConcept("vinyl listening bar")).toBeNull();
    for (const c of curatedConcepts()) for (const t of c.served) expect(["verified", "research"]).toContain(t.status);
    expect(tagUse(HEATMAP_BASELINE.tagId)).toBe("heatmap_signal");
  });

  it("serves curated place concepts at zero cost and registers their tags", async () => {
    const qloo = tagsQloo(() => []);
    const run = fakeRun(qloo.api);
    const result = await findTagsSkill.run(input([{ text: "Coffee Shop", scope: "place" }]), run.ctx);

    expect(qloo.calls).toHaveLength(0);
    expect(result.status).toBe("ok");
    expect(result.evidenceIds).toEqual([]);
    const tags = run.registry.tags();
    expect(tags.map((t) => [t.tagId, t.signalCapable])).toEqual([
      ["urn:tag:category:place:cafe", true],
      ["urn:tag:genre:place:restaurant:coffee_shop", true],
    ]);
    expect(result.forModel.top_rows.map((r) => [r.ref, r.values.use, r.values.source, r.values.status])).toEqual([
      ["T1", "place_filter", "curated", "verified"],
      ["T2", "heatmap_signal", "curated", "verified"],
    ]);
    expect(result.forModel.registered).toEqual([
      { ref: "T1", name: "Cafe", type: "urn:tag:category:place" },
      { ref: "T2", name: "Coffee shop", type: "urn:tag:genre:place" },
    ]);
    expect(result.forModel.notices[0]).toMatch(/heatmap_signal tags \(genre:place\) shape the map/);
  });

  it("lists a tag already in the registry without registering it again", async () => {
    const registry = new FakeRegistry();
    registry.registerTag({ tagId: "urn:tag:genre:place:lounge", name: "Lounge", type: "urn:tag:genre:place", signalCapable: true });
    const run = fakeRun(tagsQloo(() => []).api, registry);
    const result = await findTagsSkill.run(input([{ text: "listening lounge", scope: "place" }]), run.ctx);
    expect(result.forModel.top_rows[0]).toMatchObject({ ref: "T1", values: { use: "heatmap_signal", status: "research" } });
    expect(result.forModel.registered).toEqual([]);
  });
});

describe("find_tags: live semantic search", () => {
  it("looks up an unverified curated concept by its semantic query, taxonomy types only", async () => {
    const qloo = tagsQloo(() => WINE_ANSWER);
    const run = fakeRun(qloo.api);
    const result = await findTagsSkill.run(input([{ text: "Natural-wine bar", scope: "place" }]), run.ctx);

    expect(qloo.calls.map((c) => c.params)).toEqual([
      {
        "filter.query": "natural wine bar",
        "feature.semantic_search": true,
        "filter.parents.types": ["urn:entity:place"],
        "filter.tag.types": ["urn:tag:genre:place", "urn:tag:category:place"],
        take: TAG_SEARCH_TAKE,
      },
    ]);
    // The first heatmap tag and the first supply filter lead; the name filter dropped "Lounge".
    expect(run.registry.tags().map((t) => t.tagId)).toEqual([GENRE_WINE.id, CATEGORY_WINE.id, GENRE_NATURAL.id]);
    expect(result.status).toBe("ok");
    expect(run.ledger.evidences).toHaveLength(1);
    expect(run.ledger.evidences[0]).toMatchObject({ skill: "find_tags", status: "ok" });
    expect(result.forModel.top_rows.map((r) => r.values.use)).toEqual(["heatmap_signal", "place_filter", "heatmap_signal"]);
    expect(result.forModel.top_rows.every((r) => r.values.source === "search" && r.values.status === "live")).toBe(true);
  });

  it("puts descriptive tags after taxonomy tags and marks them as labels, never signals", () => {
    const picked = pickTags([CUISINE_WINE, GENRE_NATURAL], "natural wine bar", "place");
    expect(picked.map((t) => t.id)).toEqual([GENRE_NATURAL.id, CUISINE_WINE.id]);
  });

  it("puts the restaurant baseline last, so it never leads a concept's tags", () => {
    const baseline = { id: HEATMAP_BASELINE.tagId, name: "Restaurant", type: "urn:tag:genre:place" };
    const noodle = { id: "urn:tag:genre:place:test_noodle", name: "Noodle Restaurant", type: "urn:tag:genre:place" };
    const noodleCategory = { id: "urn:tag:category:place:test_noodle", name: "Noodle", type: "urn:tag:category:place" };
    expect(pickTags([baseline, noodleCategory, noodle], "noodle restaurant", "place").map((t) => t.id)).toEqual([noodle.id, noodleCategory.id, baseline.id]);
    expect(pickTags([baseline, CUISINE_WINE], "restaurant natural wine", "place").map((t) => t.id)).toEqual([CUISINE_WINE.id, baseline.id]);
    const full = [baseline, noodle, noodleCategory, { ...noodle, id: "urn:tag:genre:place:test_noodle_bar", name: "Noodle Restaurant Bar" }];
    expect(pickTags(full, "noodle restaurant", "place").map((t) => t.id)).not.toContain(baseline.id);
  });

  it("says a category tag found at run time counts no similar venues, so competitors stay unknown", async () => {
    const run = fakeRun(tagsQloo(() => [GENRE_WINE, CATEGORY_WINE]).api);
    const result = await findTagsSkill.run(input([{ text: "wine bar", scope: "place" }]), run.ctx);
    expect(result.forModel.notices).toContain(
      "'wine bar' has no verified venue category: T2 (Wine Bar) is not probe-verified, so geo_lift counts no similar venues with it and the competitor count stays unknown, never 0.",
    );
  });

  it("says when the baseline is among a concept's tags", async () => {
    const baseline = { id: HEATMAP_BASELINE.tagId, name: "Restaurant", type: "urn:tag:genre:place" };
    const noodleCategory = { id: "urn:tag:category:place:test_noodle", name: "Noodle Restaurant", type: "urn:tag:category:place" };
    const run = fakeRun(tagsQloo(() => [baseline, noodleCategory]).api);
    const result = await findTagsSkill.run(input([{ text: "noodle restaurant", scope: "place" }]), run.ctx);
    expect(result.forModel.top_rows.map((r) => [r.name, r.values.use])).toEqual([
      ["Noodle Restaurant", "place_filter"],
      ["Restaurant", "heatmap_signal"],
    ]);
    expect(result.forModel.notices).toContain(
      "T2 (Restaurant) is the geo_lift baseline: beside a more specific genre:place tag geo_lift leaves it out, and alone it gives every neighbourhood a lift of 1.",
    );
    expect(result.forModel.notices.join(" ")).toMatch(/'noodle restaurant' has no genre:place tag besides the baseline/);
  });

  it("keeps an unverified curated concept's own candidate tag whatever its display name", async () => {
    const bookstore = curatedConcept("bookstore");
    const candidate = bookstore?.candidates[0];
    if (bookstore === null || bookstore === undefined || candidate === undefined) throw new Error("expected a curated bookstore concept");
    expect(bookstore.served).toEqual([]);
    // Invented display names: neither holds every word of the query, or the query every word of them.
    const unrelated = { id: "urn:tag:category:place:test_paper_goods", name: "Paper Goods", type: "urn:tag:category:place" };
    const qloo = tagsQloo(() => [unrelated, { id: candidate, name: "Shop For Books", type: "urn:tag:category:place" }]);
    const run = fakeRun(qloo.api);
    const result = await findTagsSkill.run(input([{ text: "Book shop", scope: "place" }]), run.ctx);
    expect(qloo.calls[0]?.params["filter.query"]).toBe(normaliseConcept(bookstore.semanticQuery));
    expect(run.registry.tags().map((t) => t.tagId)).toEqual([candidate]);
    expect(result.status).toBe("ok");
    expect(result.forModel.top_rows[0]?.values).toMatchObject({ use: "place_filter", source: "search", status: "live" });
    expect(run.ledger.findings).toEqual([]);
    // Outside the curated concept the same name still fails the filter.
    expect(pickTags([{ id: candidate, name: "Shop For Books", type: "urn:tag:category:place" }], bookstore.semanticQuery, "place")).toEqual([]);
  });

  it("serves a concept whose supply filter failed its gate and looks one up live, labelled (fallback semantic_tag_search)", async () => {
    const pizza = curatedConcept("pizzeria");
    if (pizza === null) throw new Error("expected a curated pizza concept");
    expect(pizza.filterFallback).toBe(true);
    expect(curatedConcept("coffee shop")?.filterFallback).toBe(false);
    expect(planConcept({ text: "Pizza", scope: "place" }).request).toEqual(tagSearchParams("pizza", "place"));
    expect(planConcept({ text: "coffee shop", scope: "place" }).request).toBeNull();

    const filter = { id: "urn:tag:category:place:test_pizza_place", name: "Pizza Place", type: "urn:tag:category:place" };
    const genre = { id: "urn:tag:genre:place:test_pizza_genre", name: "Pizza", type: "urn:tag:genre:place" };
    const qloo = tagsQloo(() => [genre, filter]);
    const run = fakeRun(qloo.api);
    const result = await findTagsSkill.run(input([{ text: "pizza", scope: "place" }]), run.ctx);
    expect(qloo.calls).toHaveLength(1);
    expect(result.forModel.top_rows.map((r) => [r.name, r.values.use, r.values.source, r.values.status])).toEqual([
      ["Pizza", "heatmap_signal", "curated", "verified"],
      ["Pizza Place", "place_filter", "search", "live"],
    ]);
    // Only the supply filter is taken from the search; its other tags are not registered.
    expect(run.registry.tags().map((t) => t.tagId)).toEqual(["urn:tag:genre:place:restaurant:pizza", filter.id]);
    expect(result.forModel.notices.join(" ")).toContain("Pizzeria's supply filter T2 (Pizza Place) was found by semantic search at run time, not probe-verified");
    expect(result.forModel.notices.join(" ")).toContain("geo_lift counts no similar venues with it and the competitor count stays unknown");
    // The fallback notice says it once; the generic unverified-filter notice does not repeat it.
    expect(result.forModel.notices.filter((n) => n.includes("not probe-verified"))).toHaveLength(1);

    // No supply filter in the answer: the genre tag still serves, and the notice says supply is not sampled.
    const bare = fakeRun(tagsQloo(() => [genre]).api);
    const none = await findTagsSkill.run(input([{ text: "pizza", scope: "place" }]), bare.ctx);
    expect(none.status).toBe("ok");
    expect(none.forModel.notices).toContain(
      "Pizzeria has no verified supply filter and the live tag search found none, so geo_lift counts no similar venues for it: the competitor count is unknown.",
    );
  });

  it("searches brand and media concepts with their own parents and taxonomy types", async () => {
    const qloo = tagsQloo((p) => (p["filter.query"] === "kombucha" ? [BRAND_KOMBUCHA] : [MUSIC_DREAM_POP]));
    const run = fakeRun(qloo.api);
    const result = await findTagsSkill.run(input([{ text: "Kombucha", scope: "brand" }, { text: "dream pop", scope: "media" }]), run.ctx);

    expect(qloo.calls.map((c) => [c.params["filter.parents.types"], c.params["filter.tag.types"]])).toEqual([
      [["urn:entity:brand"], ["urn:tag:genre:brand"]],
      [["urn:entity:artist", "urn:entity:podcast", "urn:entity:tv_show", "urn:entity:movie"], ["urn:tag:genre:music", "urn:tag:genre:media"]],
    ]);
    expect(result.forModel.top_rows.map((r) => r.values.use)).toEqual(["taste_signal", "taste_signal"]);
    expect(result.forModel.notices).toEqual([]);
  });

  it("makes one call for concepts that ask the same query", async () => {
    const qloo = tagsQloo(() => WINE_ANSWER);
    const run = fakeRun(qloo.api);
    const result = await findTagsSkill.run(input([{ text: "natural wine bar", scope: "place" }, { text: "Natural Wine Bar!", scope: "place" }]), run.ctx);
    expect(qloo.calls).toHaveLength(1);
    expect(result.forModel.top_rows).toHaveLength(6);
    expect(result.forModel.top_rows.slice(0, 3).map((r) => r.ref)).toEqual(result.forModel.top_rows.slice(3).map((r) => r.ref));
  });

  it("reports EMPTY_RESULT when no tag survives the name filter", async () => {
    const qloo = tagsQloo(() => [GENRE_LOUNGE]);
    const run = fakeRun(qloo.api);
    const result = await findTagsSkill.run(input([{ text: "natural wine bar", scope: "place" }]), run.ctx);
    expect(result.status).toBe("empty");
    expect(run.ledger.evidences[0]?.status).toBe("empty");
    expect(run.ledger.findings).toHaveLength(1);
    expect(run.ledger.findings[0]).toMatchObject({ kind: "EMPTY_RESULT", suggestion: { tool: "find_tags" } });
    expect(run.ledger.findings[0]?.text).toContain("natural wine bar");
    expect(result.forModel.top_rows).toEqual([{ ref: null, name: "natural wine bar", values: { concept: "natural wine bar", scope: "place", match: "none" } }]);
  });

  it("keeps a descriptive-only answer as labels, flags it unusable and finds nothing", async () => {
    const qloo = tagsQloo(() => [CUISINE_WINE]);
    const run = fakeRun(qloo.api);
    const result = await findTagsSkill.run(input([{ text: "natural wine", scope: "place" }]), run.ctx);
    expect(result.status).toBe("empty");
    expect(run.registry.tags()[0]?.signalCapable).toBe(false);
    expect(result.forModel.top_rows[0]?.values.use).toBe("label_only");
    expect(run.ledger.evidences[0]?.status).toBe("partial");
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["EMPTY_RESULT"]);
  });

  it("tells the model when a place concept has only a supply filter", async () => {
    const qloo = tagsQloo(() => [CATEGORY_WINE]);
    const run = fakeRun(qloo.api);
    const result = await findTagsSkill.run(input([{ text: "wine bar", scope: "place" }]), run.ctx);
    expect(result.status).toBe("ok");
    expect(result.forModel.notices.join(" ")).toMatch(/'wine bar' has no genre:place tag.*concept_entities/);
  });

  it("strips hidden characters from Qloo tag names", async () => {
    const hidden = { ...GENRE_WINE, name: `Wine${String.fromCharCode(0x200b)} Bar${String.fromCharCode(0x202e)}` };
    const run = fakeRun(tagsQloo(() => [hidden]).api);
    const result = await findTagsSkill.run(input([{ text: "wine bar", scope: "place" }]), run.ctx);
    expect(result.forModel.top_rows[0]?.name).toBe("Wine Bar");
  });

  it("skips a concept with no words to search for", async () => {
    const qloo = tagsQloo(() => []);
    const run = fakeRun(qloo.api);
    const result = await findTagsSkill.run(input([{ text: "&&", scope: "brand" }]), run.ctx);
    expect(qloo.calls).toHaveLength(0);
    expect(result.status).toBe("empty");
    expect(result.forModel.notices).toEqual(["'&&' has no words to search for; not looked up."]);
  });
});

describe("find_tags: budget and failures", () => {
  it("returns a partial result when the budget stops a search", async () => {
    const qloo = tagsQloo(() => WINE_ANSWER, { budget: 1 });
    const run = fakeRun(qloo.api);
    const result = await findTagsSkill.run(
      input([
        { text: "natural wine bar", scope: "place" },
        { text: "kombucha", scope: "brand" },
        { text: "listening bar", scope: "place" },
      ]),
      run.ctx,
    );
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["BUDGET_TRUNCATED"]);
    const byConcept = (text: string) => result.forModel.top_rows.filter((r) => r.values.concept === text);
    expect(byConcept("kombucha")).toEqual([{ ref: null, name: "kombucha", values: { concept: "kombucha", scope: "brand", match: "budget_truncated" } }]);
    expect(byConcept("listening bar")[0]?.values.source).toBe("curated");
    expect(run.ledger.findings).toEqual([]);
  });

  it("keeps the other concepts when one search fails, and fails when nothing is left", async () => {
    const fail = (p: QlooParams) => p["filter.query"] === "kombucha";
    const qloo = tagsQloo(() => WINE_ANSWER, { fail });
    const run = fakeRun(qloo.api);
    const result = await findTagsSkill.run(input([{ text: "natural wine bar", scope: "place" }, { text: "kombucha", scope: "brand" }]), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.forModel.notices).toContain("The tag search for 'kombucha' failed (qloo_unavailable); not looked up.");
    expect(result.forModel.top_rows.at(-1)?.values.match).toBe("error");

    const alone = fakeRun(tagsQloo(() => [], { fail: () => true }).api);
    await expect(findTagsSkill.run(input([{ text: "kombucha", scope: "brand" }]), alone.ctx)).rejects.toThrow("upstream down");
  });
});

describe("find_tags: digest, estimate and limitations", () => {
  it("fits four concepts of long tag names in the digest, with refs and no full tag ids", async () => {
    const long = (i: number, kind: string): QlooTagSearchItem => ({
      id: `urn:tag:${kind}:test_long_${i}`,
      name: `Natural Wine Bar ${"Heritage ".repeat(8)}${i}`,
      type: kind.split(":").slice(0, 2).join(":"),
    });
    const answer = [0, 1, 2, 3].flatMap((i) => [long(i, "genre:place"), long(i, "category:place"), long(i + 10, "genre:place")]);
    const qloo = tagsQloo(() => answer);
    const run = fakeRun(qloo.api);
    const concepts = ["natural wine bar", "natural wine bar heritage", "wine bar heritage", "natural bar"].map((text) => ({ text, scope: "place" as const }));
    const result = await findTagsSkill.run(input(concepts), run.ctx);
    expect(qloo.calls).toHaveLength(4);
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "find_tags", step: "S1" })).toBe(true);
    expect(JSON.stringify(digest)).not.toContain("test_long");
    expect(digest.registered.map((t) => t.ref)).toEqual(["T1", "T2", "T3"]);
    const kept = digest.top_rows.length;
    if (kept < 12) expect(digest.notices[0]).toBe(`${12 - kept} of 12 rows left out to fit this result.`);
    else expect(kept).toBe(12);
  });

  it("estimates zero for curated concepts and one per distinct uncached search", async () => {
    const curated = input([{ text: "listening bar", scope: "place" }, { text: "cafe", scope: "place" }]);
    const probe = fakeProbe(() => false);
    expect(await findTagsSkill.estimateCalls(curated, probe, new FakeRegistry())).toBe(0);
    expect(probe.asked).toHaveLength(0);

    const live = input([
      { text: "natural wine bar", scope: "place" },
      { text: "Natural-Wine Bar", scope: "place" },
      { text: "kombucha", scope: "brand" },
    ]);
    expect(await findTagsSkill.estimateCalls(live, fakeProbe(() => false), new FakeRegistry())).toBe(2);
    const warm = fakeProbe((path, params) => path === "/v2/tags" && params["filter.query"] === "kombucha");
    expect(await findTagsSkill.estimateCalls(live, warm, new FakeRegistry())).toBe(1);
    expect(await findTagsSkill.estimateCalls(live, fakeProbe(() => true), new FakeRegistry())).toBe(0);
  });

  it("plans the same request the run sends", () => {
    expect(planConcept({ text: "Kombucha", scope: "brand" }).request).toEqual(tagSearchParams("kombucha", "brand"));
    expect(planConcept({ text: "listening bar", scope: "place" }).request).toBeNull();
  });

  it("returns its fixed method limitation", () => {
    expect(findTagsSkill.limitations(["BUDGET_TRUNCATED"])).toEqual([...SKILL_LIMITATIONS.find_tags]);
  });
});
