// The ledger views on synthetic evidence and calls: invented request ids only (D29).
import type { Evidence } from "@ct/contracts";
import type { QlooCallRecord, QuotaSnapshot } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { syntheticLedger } from "./fixtures";
import { callNumbers, evidenceByCall, renderCalls, renderEvidence, renderQuota } from "./ledger-view";

function call(n: number, overrides: Partial<QlooCallRecord> = {}): QlooCallRecord {
  return {
    qlooCallId: `qc_synthetic_${n}`,
    toolCallId: "cli-map",
    runId: null,
    path: "/v2/insights",
    filterType: "urn:entity:brand",
    query: {},
    paramsRedacted: {},
    cache: "miss",
    stale: false,
    ms: 120,
    requestId: `req-synthetic-${n}`,
    status: 200,
    rows: 4,
    cacheAgeMs: null,
    originRunId: null,
    fetchedAt: "2026-10-22T00:00:00.000Z",
    error: null,
    ...overrides,
  };
}

function bundle(id: `E${number}`, calls: number[], purpose = "Triangular similarity scoring for the Substitution Map"): Evidence {
  const base = syntheticLedger().evidence[0]!;
  return {
    ...base,
    id,
    purpose,
    qlooCallIds: calls.map((n) => `qc_synthetic_${n}`),
    requestIds: calls.map((n) => `req-synthetic-${n}`),
    provenance: { requests: calls.map(() => ({ method: "GET" as const, path: "/v2/insights" as const, query: {} })) },
  };
}

const CALLS = [1, 2, 3, 4, 5, 6, 7].map((n) => call(n));
const EVIDENCE = [bundle("E1", [1], "/search for 'Brand Alpha' as brand"), bundle("E3", [2, 3, 4, 5, 6, 7])];

describe("renderEvidence", () => {
  it("lists each bundle with the request id of every call and its number in QLOO CALLS", () => {
    const lines = renderEvidence(EVIDENCE, callNumbers(CALLS));
    expect(lines[0]).toMatch(/^ {2}id\s+skill\s+status\s+source\s+calls\s+purpose$/);
    expect(lines[1]).toMatch(/^ {2}E1\s+peer_landscape\s+ok\s+network\s+1\s+\/search for 'Brand Alpha' as brand$/);
    expect(lines[2]).toBe("      req #1 req-synthetic-1");
    expect(lines[3]).toMatch(/^ {2}E3\s+peer_landscape\s+ok\s+network\s+6\s+Triangular similarity/);
    // Wrapped by whole calls: a call number never leaves its request id.
    const block = lines.slice(4).join("\n");
    for (const n of [2, 3, 4, 5, 6, 7]) expect(block).toContain(`#${n} req-synthetic-${n}`);
    expect(lines.slice(4).every((l) => l.length <= 110)).toBe(true);
    expect(lines[5]?.startsWith("          #")).toBe(true);
  });

  it("marks a call it cannot number and shows a cached bundle", () => {
    const lines = renderEvidence([{ ...bundle("E2", [9]), cached: true }], callNumbers(CALLS));
    expect(lines[1]).toMatch(/E2\s+peer_landscape\s+ok\s+cache\s+1/);
    expect(lines[2]).toBe("      req #? req-synthetic-9");
    expect(renderEvidence([], new Map())).toEqual(["  (none)"]);
  });
});

describe("renderCalls", () => {
  it("names the evidence bundle behind each call", () => {
    const lines = renderCalls([...CALLS, call(8, { toolCallId: null, cache: "hit", requestId: null, status: null, rows: null })], evidenceByCall(EVIDENCE));
    expect(lines[0]).toMatch(/#\s+tool\s+evidence\s+endpoint\s+filter type\s+cache\s+ms\s+rows\s+status\s+request id\s+error/);
    expect(lines[1]).toMatch(/^ {2}1\s+cli-map\s+E1\s+\/v2\/insights\s+brand\s+MISS\s+120 ms\s+4\s+200\s+req-synthetic-1$/);
    expect(lines[7]).toMatch(/^ {2}7\s+cli-map\s+E3\s+/);
    // A call no bundle cites, and one served from the cache without a request id.
    expect(lines[8]).toMatch(/^ {2}8\s+—\s+—\s+\/v2\/insights\s+brand\s+HIT\s+120 ms\s+—\s+—\s+—$/);
  });

  it("lists every bundle that cites a call once", () => {
    const byCall = evidenceByCall([bundle("E1", [1, 2]), bundle("E2", [2]), bundle("E2", [2])]);
    expect(byCall.get("qc_synthetic_2")).toEqual(["E1", "E2"]);
  });
});

describe("renderQuota", () => {
  const quota: QuotaSnapshot = {
    monthLimit: 50_000,
    monthRemaining: 40_000,
    monthReset: null,
    capturedAt: "2026-10-22T00:00:00.000Z",
    lastSuccessAt: null,
    consecutiveAuthErrors: 0,
    day: "2026-10-22",
    todayNetwork: 12,
  };
  const view = { network: 2, cached: 5, quota, monthFloor: 38_000, env: "dev", tag: "dev-tools", tagCap: 200, tagUsed: 14 };

  it("shows this run, today, the month, the dev floor and the tag", () => {
    expect(renderQuota(view)).toEqual([
      "  this run      2 network · 5 cached",
      "  today         12 network (2026-10-22, this environment)",
      "  month left    40,000 of 50,000 (as of 2026-10-22T00:00:00.000Z)",
      "  dev floor     stops at 38,000, 2,000 above it",
      "  tag           dev-tools: 14 of 200 network calls used",
    ]);
  });

  it("adds the kit's live calls when the kit ran", () => {
    expect(renderQuota({ ...view, kitCalls: 3 })[1]).toBe("  kit CLI       3 live call(s) outside @ct/qloo, logged under tag dev-tools");
  });
});
