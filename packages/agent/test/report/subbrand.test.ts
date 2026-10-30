// Sub-brands and financials (Part 9 open issue 6): a brand inside a larger listed company gets no figures
// and always says so (NOT_SEPARATELY_REPORTED); a brand with no entry gets NOT_A_LISTED_COMPANY. Brand
// names are read from config/listed_companies.json, never written here as data (D29).
import { Report, type RegisteredEntity } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import listedConfig from "../../../../config/listed_companies.json";
import { listedRelationOf, listedRelationsFrom, notSeparatelyReported } from "../../src/run/listedBrands";
import { financialsNote, planScan } from "../../src/run/scan";
import { fakePublicData } from "../support/fake-publicdata";
import { intentFor, parseAll, planCall, reportWithoutFollowup, respond, run, toolUse, userTexts } from "../run/support";

type Entry = { company: string; relation: "self" | "parent"; parent_name?: string };
const BRANDS = (listedConfig as { brands: Record<string, Entry> }).brands;
const PARENT = Object.entries(BRANDS).find(([, e]) => e.relation === "parent")!;
const SELF = Object.entries(BRANDS).find(([, e]) => e.relation === "self")!;

const brand = (name: string): RegisteredEntity => ({ ref: "R1", entityId: "ent-1", name, type: "brand", popularity: null, disambiguation: null, tags: [] });
const intentOf = (name: string) => intentFor({ mentions: [{ text: name, entity_type: "brand", role: "primary", public_figure: false }] });

describe("listed relations", () => {
  it("states a relation for every entry and a parent company for every sub-brand", () => {
    for (const [name, e] of Object.entries(BRANDS)) {
      expect(["self", "parent"], name).toContain(e.relation);
      if (e.relation === "parent") expect(e.parent_name, name).toBeTruthy();
    }
    expect(listedRelationOf(PARENT[0])).toEqual({ kind: "parent", parent: PARENT[1].parent_name });
    expect(listedRelationOf(`  ${SELF[0].toUpperCase()} `)).toEqual({ kind: "self", company: SELF[1].company });
    expect(listedRelationOf("Invented Brand Nowhere")).toEqual({ kind: "unlisted" });
    expect(() => listedRelationsFrom({ brands: { X: { company: "X Co" } } })).toThrow();
  });

  it("writes the limitation naming the brand and its parent", () => {
    expect(notSeparatelyReported("Brand Gamma", "Invented Holdings Inc.")).toBe(
      "Brand Gamma is part of Invented Holdings Inc. SEC filings report Invented Holdings Inc. as a whole, so no Brand Gamma figures are shown.",
    );
  });
});

describe("the scan never reads a sub-brand's parent figures as its own", () => {
  it("plans company_financials only for a self entry, and says why otherwise", () => {
    const self = planScan("brand_health", { intent: intentOf(SELF[0]), primary: brand(SELF[0]), peers: [], publicData: true });
    expect(self.steps.map((s) => s.tool)).toContain("company_financials");
    expect(self.limitations).toEqual([]);

    const parent = planScan("brand_health", { intent: intentOf(PARENT[0]), primary: brand(PARENT[0]), peers: [], publicData: true });
    expect(parent.steps.map((s) => s.tool)).not.toContain("company_financials");
    expect(parent.limitations).toEqual([{ flag: "NOT_SEPARATELY_REPORTED", text: notSeparatelyReported(PARENT[0], PARENT[1].parent_name!) }]);

    const unlisted = planScan("brand_health", { intent: intentOf("Brand Alpha"), primary: brand("Brand Alpha"), peers: [], publicData: true });
    expect(unlisted.flags).toContain("NOT_A_LISTED_COMPANY");
  });

  it("is silent only where financials were never in question", () => {
    expect(financialsNote("site_selection", { intent: intentOf(PARENT[0]), primary: brand(PARENT[0]), publicData: true })).toBeNull();
    expect(financialsNote("brand_health", { intent: intentOf(PARENT[0]), primary: brand(PARENT[0]), publicData: false })).toBeNull();
    expect(financialsNote("brand_health", { intent: intentOf(PARENT[0]), primary: brand(PARENT[0]), publicData: true, publicConfigured: { sec: false } })).toBeNull();
  });
});

describe("runAgent: an ANALYST call for a sub-brand's financials", () => {
  it("is refused before any SEC read, and the note says the brand is not reported apart", async () => {
    const publicdata = fakePublicData();
    const { result, events, fake } = await run({
      intent: intentOf(PARENT[0]),
      publicdata,
      stream: [
        respond([planCall(), toolUse("toolu_fin", "company_financials", { brand: "R1", trigger_finding_id: null, step_id: null })]),
        ...reportWithoutFollowup(),
      ],
    });
    expect(result.status).toBe("completed");
    parseAll(events);
    expect(events.filter((e) => e.type === "public")).toEqual([]);
    expect(userTexts(fake.streamRequests[1]!).join("\n")).toContain(`${PARENT[0]} is part of`);
    const report = Report.parse(result.report);
    const flagged = report.limitations.filter((l) => l.source === "flag" && l.flag === "NOT_SEPARATELY_REPORTED");
    expect(flagged).toHaveLength(1);
  });
});
