// The DES service (P1 #1) on the Qloo mock transport: resolution through the agent's own gate (exact,
// a tie as a picker, a miss with candidates, a person refused unless vetted, before any request), each
// section from the QUANT skills, the receipts, the mode machine and the client, the answer cache and
// the limits. Invented entities only (D29).
import { describe, expect, it, vi } from "vitest";
import type { DesOutcome, Tearsheet } from "../../components/des/model";
import { cappedQloo, clock, desDeps, LIVE, OPEN_LIMITS, request, START } from "./support";

vi.mock("server-only", () => ({}));
// One curated person, as config/showcases.json would list a vetted public figure.
vi.mock("../../server/des/curated", () => ({
  isCurated: (name: string, type: string) => type === "person" && name.toLowerCase() === "comedian vega",
}));

const { DES_DOMAINS, DES_RUN_QLOO_CAP, DesService, desIntent, desKey } = await import("../../server/des/service");
const { NEIGHBOUR_ROWS } = await import("../../server/des/tearsheet");

const MIDNIGHT = "2026-10-24T00:00:00.000Z";

function ready(outcome: DesOutcome): { sheet: Tearsheet; cachedAt: string | null } {
  if (outcome.kind !== "ready") throw new Error(`expected a tearsheet, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
  return outcome;
}

function service(deps = desDeps(), options: ConstructorParameters<typeof DesService>[1] = {}) {
  return { deps, des: new DesService(deps, { limits: OPEN_LIMITS, ...options }) };
}

describe("resolution", () => {
  it("draws an exact name: every section, the key figures, the receipts and the numbers traced", async () => {
    const { des, deps } = service();
    const { sheet, cachedAt } = ready(await des.describe(request("Juniper Cola")));
    expect(cachedAt).toBeNull();
    expect(sheet.entity).toEqual({ name: "Juniper Cola", type: "brand", disambiguation: null });
    expect(sheet.picked).toBe(false);
    expect(sheet.mnemonic).toBe("JUNIPER COLA <BRAND> DES");

    // Audience DNA: the age and gender bars, then the facet tags as chips.
    expect(sheet.sections.dna.status).toBe("ok");
    expect(sheet.sections.dna.figures.map((f) => [f.dataset.kind, f.display])).toEqual([
      ["Bars", "exhibit"],
      ["Ranked", "tags"],
    ]);
    expect(sheet.sections.dna.figures[0]?.title).toMatch(/^Strongest at .+, weakest at .+$/);
    // The cultural neighbourhood: one list per domain, each cut to its head and citing its own request.
    const lists = sheet.sections.neighbours.figures;
    expect(lists.map((f) => f.title)).toHaveLength(DES_DOMAINS.length);
    for (const list of lists) {
      expect(list.dataset.kind).toBe("Ranked");
      if (list.dataset.kind !== "Ranked") continue;
      expect(list.dataset.payload.groups).toHaveLength(1);
      expect(list.dataset.payload.groups[0]?.rows.length).toBeLessThanOrEqual(NEIGHBOUR_ROWS);
    }
    expect(new Set(lists.map((f) => f.source.receipt)).size).toBe(DES_DOMAINS.length);
    expect(sheet.sections.neighbours.notes.join(" ")).not.toMatch(/seed tags|capped by popularity/i);
    // Travel taste: the quadrant, titled by its top destination, which the plot features.
    const travel = sheet.sections.travel.figures;
    expect(travel.map((f) => f.dataset.kind)).toEqual(["Quadrant"]);
    const quadrant = travel[0]?.dataset;
    if (quadrant?.kind !== "Quadrant") throw new Error("no quadrant");
    const top = [...quadrant.payload.points].sort((a, b) => b.y - a.y)[0];
    expect(travel[0]?.title).toBe(`Its taste travels furthest to ${top?.label}`);
    expect(travel[0]?.featured).toEqual([top?.key]);

    expect(sheet.keyFigures.map((k) => [k.label, k.badge])).toEqual([
      ["Popularity", "MEASURED"],
      ["Youth index", "DERIVED"],
      ["Women", "MEASURED"],
      ["Top travel-taste fit", "DERIVED"],
    ]);
    expect(sheet.keyFigures.every((k) => k.receipt !== null)).toBe(true);
    expect(sheet.keyFigures.map((k) => k.kind)).toEqual(["number", "number", "number", "name"]);

    // One search, DNA's demographics and describe, four domains and travel taste: eight requests.
    expect(sheet.receipts.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sheet.receipts[0]).toMatchObject({ endpoint: "/search", cache: "miss" });
    expect(sheet.receipts.filter((r) => r.endpoint === "/v2/insights").map((r) => r.filterLabel).sort()).toEqual(
      ["artist", "brand", "demographics", "destination", "podcast", "tv show"],
    );
    expect(sheet.requests).toEqual({ total: 8, cached: 0 });
    expect(sheet.traced.total).toBeGreaterThan(10);
    expect(sheet.traced.traced).toBe(sheet.traced.total);

    // A lane scope, so the client's lane and daily caps and the tearsheet's own run cap apply.
    expect(deps.scopes).toHaveLength(1);
    expect(deps.scopes[0]).toMatchObject({ lane: "public", pillar: "audience", limits: { qlooCalls: DES_RUN_QLOO_CAP } });
    expect(deps.scopes[0]?.runId).toMatch(/^des_[0-9a-f]{16}$/);
  });

  it("carries no Qloo entity id and no request parameter to the page", async () => {
    const { des } = service();
    const { sheet } = ready(await des.describe(request("Juniper Cola")));
    const json = JSON.stringify(sheet);
    expect(json).not.toMatch(/mock-ent-/);
    expect(json).not.toContain("signal.interests.entities");
    expect(json).not.toContain("provenance");
  });

  it("offers a picker for a name with several exact matches, keyed opaquely, and applies a pick as a pin", async () => {
    const { des } = service();
    const outcome = await des.describe(request("Juniper Twin"));
    expect(outcome.kind).toBe("pick");
    if (outcome.kind !== "pick") return;
    expect(outcome.query).toEqual({ name: "Juniper Twin", type: "brand" });
    expect(outcome.message).toBe("Pick the one you mean: each opens its own tearsheet.");
    const twins = outcome.candidates.filter((c) => c.name === "Juniper Twin");
    expect(twins).toHaveLength(2);
    expect(twins.map((c) => c.disambiguation)).toEqual(["2004", "2019"]);
    for (const c of outcome.candidates) {
      expect(c.key).toMatch(/^pk_[0-9a-f]{16}$/);
      expect(c.href).toBe(`/d/Juniper%20Twin?pick=${c.key}`);
    }
    expect(JSON.stringify(outcome)).not.toMatch(/mock-ent-/);

    const second = twins[1];
    if (!second) throw new Error("no second twin");
    const { sheet } = ready(await des.describe(request("Juniper Twin", { pick: second.key })));
    expect(sheet.entity).toEqual({ name: "Juniper Twin", type: "brand", disambiguation: "2019" });
    expect(sheet.picked).toBe(true);
    // The pin's search, the gate's (from the cache), then the sections: nine requests.
    expect(sheet.receipts).toHaveLength(9);
  });

  it("shows the picker again for a pick that is no longer among the results", async () => {
    const { des } = service();
    const outcome = await des.describe(request("Juniper Twin", { pick: "pk_0000000000000000" }));
    expect(outcome.kind).toBe("pick");
  });

  it("offers the closest names for a name with no exact match and applies none", async () => {
    const { des } = service();
    const outcome = await des.describe(request("Notfound Cola"));
    expect(outcome.kind).toBe("not_found");
    if (outcome.kind !== "not_found") return;
    expect(outcome.message).toBe("Check the spelling or the type, or open one of the closest names below.");
    expect(outcome.candidates.length).toBeGreaterThan(0);
    expect(outcome.candidates.every((c) => c.name !== "Notfound Cola" && c.href.includes("pick=pk_"))).toBe(true);
  });

  it("refuses a person who is neither curated nor vetted before any Qloo request, Qloo on or off", async () => {
    const qloo = vi.fn();
    const vettedPerson = vi.fn(async () => false);
    const { des, deps } = service(desDeps({ vettedPerson }));
    const outcome = await des.describe(request("Neighbour Vega", { type: "person" }));
    expect(outcome).toEqual({
      kind: "refused",
      query: { name: "Neighbour Vega", type: "person" },
      message: expect.stringMatching(/^This name is not among the vetted public figures, so no Qloo request was made for it\./),
    });
    expect(vettedPerson).toHaveBeenCalledWith("Neighbour Vega");
    expect(deps.scopes).toHaveLength(0);

    const off = service(desDeps({ qlooEnabled: false, qloo }));
    expect((await off.des.describe(request("Neighbour Vega", { type: "person" }))).kind).toBe("refused");
    // A picked key changes nothing: the name is still never sent.
    expect((await off.des.describe(request("Neighbour Vega", { type: "person", pick: "pk_00000000000000aa" }))).kind).toBe("refused");
    expect(qloo).not.toHaveBeenCalled();
  });

  it("refuses when the vetting check fails, and only curated persons pass without one", async () => {
    const failing = service(
      desDeps({
        vettedPerson: async () => {
          throw new Error("database down");
        },
      }),
    );
    expect((await failing.des.describe(request("Comedian Nova", { type: "person" }))).kind).toBe("refused");
    expect(failing.deps.scopes).toHaveLength(0);
    const unwired = service();
    expect((await unwired.des.describe(request("Comedian Nova", { type: "person" }))).kind).toBe("refused");
    expect(ready(await unwired.des.describe(request("Comedian Vega", { type: "person" }))).sheet.entity.type).toBe("person");
  });

  it("describes a vetted person with the gate's one search, as for any other type", async () => {
    const { des } = service(desDeps({ vettedPerson: async (name) => name === "Comedian Nova" }));
    const { sheet } = ready(await des.describe(request("Comedian Nova", { type: "person" })));
    expect(sheet.entity).toMatchObject({ name: "Comedian Nova", type: "person" });
    expect(sheet.receipts.filter((r) => r.endpoint === "/search")).toHaveLength(1);
  });

  it("writes the intent the gate reads as CLERK would for <NAME> DES", () => {
    expect(desIntent({ name: "Artist Nova", type: "artist" }, true)).toMatchObject({
      pillar: "audience",
      job: "audience_discovery",
      mentions: [{ text: "Artist Nova", entity_type: "artist", role: "primary", public_figure: false }],
      mnemonic: "ARTIST NOVA <ARTIST> DES",
    });
    expect(desIntent({ name: "Comedian Vega", type: "person" }, true).mentions[0]?.public_figure).toBe(true);
  });
});

describe("the mode machine and the client", () => {
  it("is off with QLOO_DISABLED, without creating a client", async () => {
    const qloo = vi.fn();
    const { des } = service(desDeps({ qlooEnabled: false, qloo }));
    const outcome = await des.describe(request("Juniper Cola"));
    expect(outcome).toMatchObject({ kind: "unavailable", cause: "qloo_off", until: null });
    expect(qloo).not.toHaveBeenCalled();
  });

  it("pauses while the lane is replay only, saying why and until when", async () => {
    const paused = desDeps({ mode: async () => ({ mode: "replay_only", breaker: "stored", reason: "it was paused by the operator", until: null }) });
    expect(await service(paused).des.describe(request("Juniper Cola"))).toEqual({
      kind: "unavailable",
      cause: "paused",
      message: "Live tearsheets are paused: it was paused by the operator. Tearsheets computed earlier, showcases and replays still open.",
      until: null,
    });
    const spent = desDeps({ mode: async () => ({ mode: "replay_only", breaker: "qloo_daily", reason: "today's Qloo requests are used up", until: MIDNIGHT }) });
    const outcome = await service(spent).des.describe(request("Juniper Cola"));
    expect(outcome).toMatchObject({ kind: "unavailable", cause: "budget", until: MIDNIGHT });
    if (outcome.kind === "unavailable") expect(outcome.message).toMatch(/resume at 00:00 UTC/);
    expect(spent.scopes).toHaveLength(0);
  });

  it("words the month floor as a pause that does not lift at midnight", async () => {
    const floor = desDeps({ mode: async () => ({ mode: "replay_only", breaker: "qloo_floor", reason: "this month's Qloo quota is at its floor", until: null }) });
    const outcome = await service(floor).des.describe(request("Juniper Cola"));
    expect(outcome).toMatchObject({ kind: "unavailable", cause: "paused", until: null });
    if (outcome.kind === "unavailable") expect(outcome.message).not.toMatch(/00:00/);
  });

  it("asks the mode of the visitor's lane, and runs in economy: a tearsheet makes no LLM call", async () => {
    const mode = vi.fn(async () => ({ mode: "economy" as const, breaker: "llm_spend" as const, reason: "today's live budget is nearly used", until: null }));
    const deps = desDeps({ mode });
    const outcome = await service(deps).des.describe(request("Juniper Cola", {}, { lane: "judge" }));
    expect(outcome.kind).toBe("ready");
    expect(mode).toHaveBeenCalledWith("judge");
    expect(deps.scopes[0]?.lane).toBe("judge");
  });

  it("is unavailable when the Qloo client cannot be configured", async () => {
    const { des } = service(
      desDeps({
        qloo: () => {
          throw new Error("QLOO_API_KEY is not set");
        },
      }),
    );
    expect(await des.describe(request("Juniper Cola"))).toMatchObject({ kind: "unavailable", cause: "unconfigured" });
  });

  it("pauses until 00:00 UTC when the client's daily lane cap refuses the lookup, and for the month floor", async () => {
    const c = clock();
    const daily = service(desDeps({ qloo: () => cappedQloo(), now: c.now }));
    expect(await daily.des.describe(request("Juniper Cola"))).toMatchObject({ kind: "unavailable", cause: "budget", until: MIDNIGHT });
    const floor = service(desDeps({ qloo: () => cappedQloo("month_floor"), now: c.now }));
    const outcome = await floor.des.describe(request("Juniper Cola"));
    expect(outcome).toMatchObject({ kind: "unavailable", cause: "paused", until: null });
    if (outcome.kind === "unavailable") expect(outcome.message).toMatch(/this month's Qloo quota is at its floor/);
  });

  it("fails with a retryable message when the mode cannot be read", async () => {
    const { des } = service(
      desDeps({
        mode: async () => {
          throw new Error("database down");
        },
      }),
    );
    expect(await des.describe(request("Juniper Cola"))).toEqual({ kind: "failed", message: expect.stringMatching(/Try again shortly/) });
  });
});

describe("the answer cache", () => {
  it("serves a computed tearsheet again with no request, in any mode, until it expires", async () => {
    const c = clock();
    let mode = LIVE;
    const deps = desDeps({ mode: async () => mode, now: c.now });
    const des = new DesService(deps, { limits: OPEN_LIMITS, answerTtlMs: 60_000 });
    const first = ready(await des.describe(request("Juniper Cola")));
    expect(deps.scopes).toHaveLength(1);

    c.ms += 30_000;
    mode = { mode: "replay_only", breaker: "stored", reason: "it was paused by the operator", until: null };
    const again = ready(await des.describe(request("Juniper Cola")));
    expect(again.sheet).toBe(first.sheet);
    expect(again.cachedAt).toBe(first.sheet.computedAt);
    expect(deps.scopes).toHaveLength(1);

    c.ms += 30_000;
    expect((await des.describe(request("Juniper Cola"))).kind).toBe("unavailable");
  });

  it("serves another spelling of the name the same tearsheet, under its own name and command", async () => {
    const { des, deps } = service();
    const first = ready(await des.describe(request("Juniper Cola")));
    // Names compare as the gate compares them: a leading article and a company suffix fall away.
    const other = ready(await des.describe(request("The Juniper Cola Co")));
    expect(deps.scopes).toHaveLength(1);
    expect(other.sheet.query).toEqual({ name: "The Juniper Cola Co", type: "brand" });
    expect(other.sheet.mnemonic).toBe("THE JUNIPER COLA CO <BRAND> DES");
    expect(other.sheet.sections).toBe(first.sheet.sections);
    // The first spelling still reads as its own.
    expect(ready(await des.describe(request("Juniper Cola"))).sheet.mnemonic).toBe("JUNIPER COLA <BRAND> DES");
  });

  it("keys a pick apart from the bare name, and keeps no picker", async () => {
    expect(desKey({ name: "Juniper Twin", type: "brand", pick: null })).not.toBe(desKey({ name: "Juniper Twin", type: "brand", pick: "pk_00000000000000aa" }));
    expect(desKey({ name: "Juniper Twin", type: "brand", pick: null })).not.toBe(desKey({ name: "Juniper Twin", type: "artist", pick: null }));
    const { des, deps } = service();
    await des.describe(request("Juniper Twin"));
    await des.describe(request("Juniper Twin"));
    expect(deps.scopes).toHaveLength(2);
  });

  it("computes a tearsheet once for requests that arrive together, each told under its own spelling", async () => {
    const { des, deps } = service();
    const [a, b] = await Promise.all([des.describe(request("Juniper Cola")), des.describe(request("The Juniper Cola Co"))]);
    expect(deps.scopes).toHaveLength(1);
    expect(ready(a).sheet.mnemonic).toBe("JUNIPER COLA <BRAND> DES");
    expect(ready(b).sheet.mnemonic).toBe("THE JUNIPER COLA CO <BRAND> DES");
    expect(ready(b).sheet.sections).toBe(ready(a).sheet.sections);

    const [p, q] = await Promise.all([des.describe(request("Juniper Twin")), des.describe(request("The Juniper Twin"))]);
    expect(p.kind).toBe("pick");
    if (q.kind !== "pick") throw new Error(`expected a picker, got ${q.kind}`);
    expect(q.query.name).toBe("The Juniper Twin");
    expect(q.candidates.every((c) => c.href.startsWith("/d/The%20Juniper%20Twin?pick=pk_"))).toBe(true);
  });
});

describe("limits", () => {
  it("limits new tearsheets per visitor, never a cached one, and not a visitor without an address", async () => {
    const c = clock();
    const deps = desDeps({ now: c.now });
    const des = new DesService(deps, { limits: { ...OPEN_LIMITS, visitorPerMinute: 2 } });
    const visitor = { visitor: "visitor-key-a" };
    expect((await des.describe(request("Brand Alpha", {}, visitor))).kind).toBe("ready");
    c.ms += 10_000;
    expect((await des.describe(request("Brand Beta", {}, visitor))).kind).toBe("ready");
    expect((await des.describe(request("Brand Alpha", {}, visitor))).kind).toBe("ready");
    const limited = await des.describe(request("Brand Gamma", {}, visitor));
    expect(limited).toEqual({ kind: "limited", message: expect.stringMatching(/Try again in 50 s/), retryAfterS: 50 });
    expect((await des.describe(request("Brand Gamma", {}, { visitor: "visitor-key-b" }))).kind).toBe("ready");
    expect((await des.describe(request("Brand Delta"))).kind).toBe("ready");
    c.ms += 50_000;
    expect((await des.describe(request("Brand Epsilon", {}, visitor))).kind).toBe("ready");
  });

  it("pauses until 00:00 UTC once tearsheets used the day's share of fresh Qloo calls", async () => {
    const c = clock();
    const des = new DesService(desDeps({ now: c.now }), { limits: { ...OPEN_LIMITS, dailyNetworkCalls: DES_RUN_QLOO_CAP + 8 } });
    expect((await des.describe(request("Brand Alpha"))).kind).toBe("ready");
    expect(des.networkToday()).toBe(8);
    expect((await des.describe(request("Brand Beta"))).kind).toBe("ready");
    expect(des.networkToday()).toBe(16);
    expect(await des.describe(request("Brand Gamma"))).toEqual({
      kind: "unavailable",
      cause: "budget",
      message: expect.stringMatching(/used up\. Tearsheets resume at 00:00 UTC/),
      until: MIDNIGHT,
    });
    c.ms = Date.parse(MIDNIGHT) + 1_000;
    expect((await des.describe(request("Brand Gamma"))).kind).toBe("ready");
  });

  it("holds each lookup's whole cap while it runs, so lookups started together cannot pass the day's share", async () => {
    const des = new DesService(desDeps({ now: () => START }), { limits: { ...OPEN_LIMITS, dailyNetworkCalls: 2 * DES_RUN_QLOO_CAP } });
    const outcomes = await Promise.all(["Brand Alpha", "Brand Beta", "Brand Gamma"].map((name) => des.describe(request(name))));
    expect(outcomes.map((o) => o.kind)).toEqual(["ready", "ready", "unavailable"]);
    expect(des.networkToday()).toBe(16);
  });
});
