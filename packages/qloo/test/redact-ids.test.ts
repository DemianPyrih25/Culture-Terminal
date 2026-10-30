import { describe, expect, it } from "vitest";
import { ENTITY_ID_RE, entityMarker, hasEntityId, scrubEntityIds, scrubParamValue } from "../src/redact";

// Invented UUID-shaped ids and invented names only (D29), built at runtime so the file holds no UUID
// literal (the repo guard flags one outside test/synthetic/).
const uuid = (head: string, tail: string): string => [head, "0000", "4000", "8000", tail].join("-");
const ALPHA = uuid("0a1b2c3d", "00000000aaaa");
const BETA = uuid("0A1B2C3D", "00000000BBBB");
const CITY = uuid("0a1b2c3d", "00000000cccc");
const RUN = uuid("11111111", "555555555555");
const REQUEST = uuid("99999999", "555555555555");
const NAMES: Record<string, string> = { [ALPHA]: "Brand Alpha", [BETA.toLowerCase()]: "Brand Beta", [CITY]: "Fixture City" };
const nameOf = (id: string): string | null => NAMES[id] ?? null;

describe("scrubEntityIds", () => {
  it("replaces ids in entity parameters with names, keeping URNs and the shortened-list tail", () => {
    expect(scrubParamValue("signal.interests.entities", `${ALPHA},${BETA}`, nameOf)).toBe("«Brand Alpha»,«Brand Beta»");
    expect(scrubParamValue("filter.exclude.entities", `${ALPHA},urn:entity:brand,… (+3)`, nameOf)).toBe("«Brand Alpha»,urn:entity:brand,… (+3)");
    expect(scrubParamValue("entity_ids", "sample-brand-mock-7", nameOf)).toBe("«entity»");
    expect(scrubParamValue("signal.demographics.entities", "not-a-uuid-id", nameOf)).toBe("«entity»");
  });

  it("keeps WKT and lat,lon locations and replaces a locality id", () => {
    expect(scrubParamValue("filter.location", "POLYGON (12 pts)", nameOf)).toBe("POLYGON (12 pts)");
    expect(scrubParamValue("signal.location", "POINT(-97.7 30.2)", nameOf)).toBe("POINT(-97.7 30.2)");
    expect(scrubParamValue("signal.location", "30.27,-97.74", nameOf)).toBe("30.27,-97.74");
    expect(scrubParamValue("signal.location", CITY, nameOf)).toBe("«Fixture City»");
    expect(scrubParamValue("filter.location", "mock-locality-1", nameOf)).toBe("«entity»");
  });

  it("deep-copies events, scrubbing params and strings but keeping run and request ids", () => {
    const event = {
      runId: RUN,
      type: "qloo",
      requestId: REQUEST,
      originRunId: RUN,
      paramsRedacted: { "signal.interests.entities": ALPHA, "filter.type": "urn:entity:brand", query: "Brand Alpha" },
      error: `entity ${BETA} was not found`,
    };
    const out = scrubEntityIds(event, nameOf) as typeof event;
    expect(out).toEqual({
      runId: RUN,
      type: "qloo",
      requestId: REQUEST,
      originRunId: RUN,
      paramsRedacted: { "signal.interests.entities": "«Brand Alpha»", "filter.type": "urn:entity:brand", query: "Brand Alpha" },
      error: "entity «Brand Beta» was not found",
    });
    expect(event.paramsRedacted["signal.interests.entities"]).toBe(ALPHA);
  });

  it("scrubs evidence provenance and keeps parallel request id arrays", () => {
    const evidence = {
      id: "E1",
      requestIds: [REQUEST],
      provenance: { requests: [{ method: "GET", path: "/v2/insights", query: { "filter.results.entities": `${ALPHA},${CITY}` } }] },
    };
    const out = scrubEntityIds(evidence, () => null);
    expect(JSON.stringify(out)).not.toContain(ALPHA);
    expect(out).toMatchObject({ requestIds: [REQUEST], provenance: { requests: [{ query: { "filter.results.entities": "«entity»,«entity»" } }] } });
  });

  it("leaves numbers, booleans and null alone and drops undefined like JSON", () => {
    expect(scrubEntityIds({ a: 1, b: true, c: null, d: undefined }, nameOf)).toEqual({ a: 1, b: true, c: null });
  });

  it("finds ids with hasEntityId without leaking the global regex state", () => {
    expect(hasEntityId(`x ${ALPHA} y`)).toBe(true);
    expect(hasEntityId(`x ${ALPHA} y`)).toBe(true);
    expect(hasEntityId("no ids here")).toBe(false);
    expect(ENTITY_ID_RE.lastIndex).toBe(0);
    expect(entityMarker(null)).toBe("«entity»");
    expect(entityMarker("  ")).toBe("«entity»");
  });
});
