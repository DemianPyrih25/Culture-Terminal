// R8 (D51) in the How we know drawer: a Qloo lookup opens its request with the endpoint, readable parameters
// (names where entity ids were), the request id and "Copy request", with the ids line and no curl; an
// OpenStreetMap lookup shows its Overpass query and an "Open in Overpass Turbo" link; SEC and Census keep
// their exact links. Every value here is invented.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { callQueries, overpassLink, OVERPASS_TURBO_URL, publicRequestLink, QLOO_IDS_LINE, requestCopy, SourceRow, sourceDescription, sourceLine, type Lookup } from "../../components/drawer";
import { publicNote } from "../../components/drawer/source-row";
import { text } from "../working/support";

vi.mock("server-only", () => ({}));

/** A UUID-shaped entity id (the shape of @ct/qloo ENTITY_ID_RE). */
const ENTITY_ID_RE_SOURCE = "\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b";

const qloo: Lookup = {
  qlooCallId: "qc-1",
  endpoint: "/v2/insights",
  filterType: "urn:entity:brand",
  filterLabel: "brand",
  refs: ["R1 Brand Alpha"],
  params: [
    ["filter.type", "urn:entity:brand"],
    ["signal.interests.entities", "«Brand Alpha»,«Brand Beta»"],
  ],
  rows: 6,
  cache: "hit",
  cacheAgeMs: 3_600_000,
  at: "2026-10-30T09:00:00.000Z",
  requestId: "req-invented-qloo-0001",
  shortRequestId: "req-…0001",
};

const QL = '[out:json][timeout:25][maxsize:33554432];(nwr["amenity"="cafe"](poly:"30.26 -97.73 30.27 -97.72 30.25 -97.71"););out count;';

const osm: Lookup = {
  qlooCallId: "pc-osm-1",
  source: "osm",
  host: "overpass-api.de",
  endpoint: "/api/interpreter",
  filterType: null,
  filterLabel: null,
  refs: [],
  params: [],
  rows: null,
  cache: "miss",
  cacheAgeMs: null,
  at: "2026-10-30T09:00:00.000Z",
  requestId: "osm-2026-10-28T06:00:00Z",
  shortRequestId: "osm-2026-10-28T06:00:00Z",
};

describe("a Qloo lookup", () => {
  const html = renderToStaticMarkup(<SourceRow lookup={qloo} query={{ path: "/v2/insights", query: { "filter.type": "urn:entity:brand", "signal.interests.entities": "«Brand Alpha»,«Brand Beta»", take: "6" } }} defaultOpen />);

  it("shows the endpoint, the parameters as names and the request id, and offers Copy request", () => {
    const t = text(html);
    expect(t).toContain("/v2/insights · brand · 6 rows");
    expect(t).toContain("«Brand Alpha», «Brand Beta»");
    expect(t).toContain("req-…0001");
    expect(t).toContain("Copy request");
    expect(t).toContain(QLOO_IDS_LINE);
  });

  it("never offers a curl, a key placeholder or an entity id", () => {
    expect(html).not.toMatch(/curl|QLOO_API_KEY|x-api-key/i);
    expect(html).not.toMatch(new RegExp(ENTITY_ID_RE_SOURCE, "i"));
    expect(requestCopy(qloo, null)?.text).toContain("request id: req-invented-qloo-0001");
  });
});

describe("an OpenStreetMap lookup", () => {
  const query = { path: "/api/interpreter", query: {}, host: "overpass-api.de", method: "POST" as const, body: QL };

  it("is described in words and keeps its host", () => {
    expect(sourceDescription(osm)).toBe("Places counted in OpenStreetMap (Overpass API)");
    expect(sourceLine(osm)).toBe("overpass-api.de/api/interpreter · OpenStreetMap");
  });

  it("shows its Overpass query and an Overpass Turbo link that runs it, never a Qloo copy", () => {
    const link = overpassLink(osm, query);
    expect(link?.url).toBe(`${OVERPASS_TURBO_URL}?Q=${encodeURIComponent(QL)}&R`);
    expect(requestCopy(osm, query)).toBeNull();
    expect(publicRequestLink(osm, query)).toBeNull();
    const html = renderToStaticMarkup(<SourceRow lookup={osm} query={query} defaultOpen />);
    const t = text(html);
    expect(t).toContain("Open in Overpass Turbo");
    expect(t).toContain("Copy query");
    expect(html).toContain("data-overpass-query");
    expect(t).toContain("© OpenStreetMap contributors");
    expect(t).not.toContain(QLOO_IDS_LINE);
  });

  it("says when the query was not recorded, and marks test data from the mock", () => {
    expect(overpassLink(osm, null)).toBeNull();
    expect(publicNote(osm, null)).toContain("The exact query was not recorded");
    expect(overpassLink({ ...osm, requestId: "mock-ab12" }, query)).toBeNull();
    expect(publicNote({ source: "osm", requestId: "mock-ab12" }, null)).toMatch(/^Test data/);
  });

  it("keeps the Overpass body from the evidence provenance", () => {
    const queries = callQueries({
      E1: {
        id: "E1",
        source: "osm",
        qlooCallIds: ["pc-osm-1"],
        requestIds: ["osm-2026-10-28T06:00:00Z"],
        provenance: { requests: [{ source: "osm", method: "POST", host: "overpass-api.de", path: "/api/interpreter", query: {}, reference: "osm-2026-10-28T06:00:00Z", body: QL }] },
      },
    } as never);
    expect(queries.get("pc-osm-1")).toMatchObject({ host: "overpass-api.de", method: "POST", body: QL });
  });
});
