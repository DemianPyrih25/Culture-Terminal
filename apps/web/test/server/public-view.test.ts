// R8 (D51): what a browser reads about a run carries names, never Qloo entity ids. The read boundary
// (server/public-view.ts) scrubs stored events, the reduced state, datasets and the SSE stream; request ids
// and run ids stay so receipts still open every number's request. Invented ids (built at runtime, so the
// file holds no UUID literal) and invented names only.
import { describe, expect, it, vi } from "vitest";
import { reduceRunEvents, stampEvent, type EventInput, type RunEvent } from "@ct/contracts";
import { hasEntityId } from "@ct/qloo";

vi.mock("server-only", () => ({}));

const { collectEntityNames, localityNames, nameIndexOf, publicEvent, publicEventStream, publicEvents, publicJson, publicRunState } = await import(
  "../../server/public-view"
);
const { sampleEvents } = await import("../../server/samples");

const uuid = (head: string, tail: string): string => [head, "0000", "4000", "8000", tail].join("-");
const BRAND = uuid("0a1b2c3d", "00000000aaaa");
const PEER = uuid("0a1b2c3d", "00000000bbbb");
const CITY = uuid("0a1b2c3d", "00000000cccc");
const RUN = uuid("11111111", "555555555555");
const REQUEST = uuid("99999999", "555555555555");

const names = nameIndexOf(new Map([[BRAND, "Juniper Cola"], [CITY, "Fixture City"]]));

const stamp = (seq: number, input: EventInput): RunEvent => stampEvent(input, { seq, ts: "2026-10-30T10:00:00.000Z", runId: RUN });

const qlooEvent: EventInput = {
  type: "qloo",
  qlooCallId: "qc_0000000000000001",
  toolCallId: "scan-1",
  endpoint: "/v2/insights",
  filterType: "urn:entity:brand",
  paramsRedacted: { "signal.interests.entities": `${BRAND},${PEER}`, "signal.location": CITY, "filter.type": "urn:entity:brand" },
  cache: "miss",
  ms: 120,
  requestId: REQUEST,
  status: 200,
  rows: 20,
  cacheAgeMs: null,
  originRunId: RUN,
  error: null,
};

const evidenceEvent: EventInput = {
  type: "evidence",
  evidence: {
    id: "E1",
    skill: "peer_landscape",
    source: "qloo",
    purpose: "Peers of Juniper Cola",
    status: "ok",
    qlooCallIds: ["qc_0000000000000001"],
    requestIds: [REQUEST],
    cached: false,
    fetchedAt: "2026-10-30T10:00:00.000Z",
    provenance: { requests: [{ method: "GET", path: "/v2/insights", query: { "filter.results.entities": `${BRAND},${PEER}` } }] },
    summary: "20 peers.",
    flags: [],
    qualityGateDrops: 0,
  },
};

describe("the name index", () => {
  it("collects every entity id with a name from a cached Qloo body, and every pinned locality", () => {
    const found = new Map<string, string>();
    collectEntityNames({ results: { entities: [{ entity_id: BRAND.toUpperCase(), name: "Juniper Cola", query: { affinity: 0.7 } }, { entity_id: PEER }] } }, found);
    collectEntityNames({ results: [{ entity_id: CITY, name: " Fixture City " }] }, found);
    expect(found).toEqual(new Map([[BRAND, "Juniper Cola"], [CITY, "Fixture City"]]));
    expect(localityNames({ austin: { entityId: CITY, label: "Austin" }, broken: { label: "No id" } })).toEqual(new Map([[CITY, "Austin"]]));
    expect(localityNames(undefined)).toEqual(new Map());
  });

  it("counts the ids it could not name", () => {
    const index = nameIndexOf(new Map([[BRAND, "Juniper Cola"]]));
    expect(index.nameOf(BRAND.toUpperCase())).toBe("Juniper Cola");
    expect(index.misses).toBe(0);
    expect(index.nameOf(PEER)).toBeNull();
    expect(index.misses).toBe(1);
  });
});

describe("the read boundary", () => {
  it("names entities in events and keeps request ids, run ids and the rest of the receipt", () => {
    const [q, e] = publicEvents([stamp(1, qlooEvent), stamp(2, evidenceEvent)], names.nameOf);
    expect(q).toMatchObject({
      seq: 1,
      runId: RUN,
      type: "qloo",
      requestId: REQUEST,
      originRunId: RUN,
      paramsRedacted: { "signal.interests.entities": "«Juniper Cola»,«entity»", "signal.location": "«Fixture City»", "filter.type": "urn:entity:brand" },
    });
    expect(e).toMatchObject({ evidence: { requestIds: [REQUEST], provenance: { requests: [{ query: { "filter.results.entities": "«Juniper Cola»,«entity»" } }] } } });
    const text = JSON.stringify([q, e]);
    expect(text).not.toContain(BRAND);
    expect(text).not.toContain(PEER);
    expect(text).not.toContain(CITY);
  });

  it("scrubs the reduced state a snapshot and the pages read, keeping its run id", () => {
    const state = reduceRunEvents(RUN, [stamp(1, qlooEvent), stamp(2, evidenceEvent)]);
    const scrubbed = publicRunState(state, names.nameOf);
    expect(scrubbed.runId).toBe(RUN);
    const text = JSON.stringify(scrubbed);
    expect(text).not.toContain(PEER);
    expect(text).toContain(REQUEST);
  });

  it("scrubs a dataset envelope or any JSON payload", () => {
    expect(publicJson({ rows: [{ name: `look-alike of ${PEER}` }] }, names.nameOf)).toEqual({ rows: [{ name: "look-alike of «entity»" }] });
  });

  it("leaves the synthetic samples readable: their mock ids become «entity», everything else is unchanged", () => {
    const events = sampleEvents("brand-health");
    const scrubbed = events.map((event) => publicEvent(event, () => null));
    expect(scrubbed.map((e) => e.type)).toEqual(events.map((e) => e.type));
    const qloo = scrubbed.find((e) => e.type === "qloo" && Object.hasOwn(e.paramsRedacted, "signal.interests.entities"));
    expect(qloo?.type === "qloo" ? qloo.paramsRedacted["signal.interests.entities"] : null).toMatch(/^«entity»/);
    expect(scrubbed.some((e) => hasEntityId(JSON.stringify(e)))).toBe(false);
  });
});

describe("the SSE stream", () => {
  it("scrubs every event as it leaves, in order", async () => {
    const db = {
      query: {
        qlooCalls: { findMany: async () => [] },
        qlooCache: { findMany: async () => [] },
      },
    } as unknown as Parameters<typeof publicEventStream>[0];
    async function* source(): AsyncGenerator<RunEvent> {
      yield stamp(1, qlooEvent);
      yield stamp(2, evidenceEvent);
    }
    const out: RunEvent[] = [];
    for await (const event of publicEventStream(db, `${RUN}-stream`, source())) out.push(event);
    expect(out.map((e) => e.seq)).toEqual([1, 2]);
    expect(JSON.stringify(out)).not.toContain(BRAND);
    expect(out[0]).toMatchObject({ requestId: REQUEST });
  });
});
