// Shared report context for the assembler tests: an invented run and its Qloo call log (D29).
import type { ReportContext } from "../../src/assemble";
import type { LedgerSnapshot } from "../../src/ledger";
import type { ReceiptQlooCall } from "../../src/report/receipt";
import { CREATED_AT, plan } from "../ledger/fixtures";

const brand = { endpoint: "/v2/insights", filterType: "urn:entity:brand" } as const;
export const QLOO_CALLS: ReceiptQlooCall[] = [
  { qlooCallId: "qc-08", endpoint: "/search", filterType: null, cache: "miss" },
  { qlooCallId: "qc-01", ...brand, cache: "hit" },
  { qlooCallId: "qc-02", ...brand, cache: "hit" },
  { qlooCallId: "qc-03", ...brand, cache: "hit" },
  { qlooCallId: "qc-04", ...brand, cache: "reused" },
  { qlooCallId: "qc-05", endpoint: "/v2/trending", filterType: "urn:entity:brand", cache: "stale" },
  { qlooCallId: "qc-06", endpoint: "/v2/insights", filterType: "urn:demographics", cache: "coalesced" },
  { qlooCallId: "qc-07", endpoint: "/v2/insights", filterType: "urn:entity:artist", cache: "miss" },
  { qlooCallId: "qc-01", ...brand, cache: "hit" },
];

export function context(ledger: LedgerSnapshot, overrides: Partial<ReportContext> = {}): ReportContext {
  return {
    runId: "run-alpha-01",
    question: "Is the Brand Alpha audience a moat or a niche?",
    job: "brand_health",
    mode: "live",
    createdAt: CREATED_AT,
    plan: plan(),
    ledger,
    qlooCalls: QLOO_CALLS,
    usage: { elapsedMs: 95_432.6, llmUsd: 0.21, tokens: { input: 12_000, output: 3_000, cacheRead: 8_000, cacheCreation: 2_000 } },
    models: { clerk: "claude-haiku-5-5", analyst: "claude-sonnet-5-5", ghost: null },
    droppedEntities: 1,
    codeFallbacks: 0,
    ...overrides,
  };
}

