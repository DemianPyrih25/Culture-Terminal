import { describe, expect, it } from "vitest";
import { indexSnapshot } from "../../src/ledger";
import {
  citedIds,
  draftProse,
  insertAfterMetricToken,
  metricText,
  metricTokenOccurrences,
  plainProse,
  renderProse,
  resolveProse,
  tokenProblems,
  windowText,
} from "../../src/tokens";
import { brandHealthLedger, validDraft, WINDOW } from "../ledger/fixtures";

const lookup = indexSnapshot(brandHealthLedger().snapshot());

describe("token helpers", () => {
  it("resolves metric and evidence tokens against the ledger", () => {
    const segments = resolveProse("Up {{M1}} [E1] over {{WINDOW}}, not {{M99}}.", lookup);
    expect(segments.map((s) => s.kind)).toEqual(["text", "metric", "text", "evidence", "text", "window", "text", "metric", "text"]);
    expect(segments[1]).toMatchObject({ kind: "metric", id: "M1", metric: { display: "0.62" } });
    expect(segments[7]).toMatchObject({ kind: "metric", id: "M99", metric: null });
  });

  it("lists unresolved and malformed tokens once each", () => {
    expect(tokenProblems("{{M98}} {{M98}} [E7] {{m1}} [E1]", lookup)).toEqual({
      metrics: ["M98"],
      evidence: ["E7"],
      malformed: ["{{m1}}"],
    });
  });

  it("counts token occurrences and unions cited ids with explicit lists", () => {
    expect(metricTokenOccurrences("{{M1}} and {{M1}} and {{M2}}")).toEqual(["M1", "M1", "M2"]);
    expect(citedIds("M", ["M3", "bad", "M1"], ["{{M1}} {{M4}}", "[E2]"])).toEqual(["M3", "M1", "M4"]);
    expect(citedIds("E", ["E1"], ["{{M1}} [E2] [E1]"])).toEqual(["E1", "E2"]);
  });

  it("inserts after the first occurrence of a metric token only", () => {
    expect(insertAfterMetricToken("{{M5}} then {{M5}}", "M5", "!")).toBe("{{M5}}! then {{M5}}");
    expect(insertAfterMetricToken("no token", "M5", "!")).toBe("no token");
  });

  it("renders prose as plain text with values, badges and the window", () => {
    expect(renderProse("Momentum {{M5}} over {{WINDOW}} [E3]; gap {{M99}}.", lookup, WINDOW)).toBe(
      "Momentum Rising (STALE) over 2025-04-01..2025-09-30 [E3]; gap n/a.",
    );
    expect(metricText(lookup.metric("M2")!)).toBe("2 of 6 (DERIVED)");
    expect(windowText(null)).toBe("the trending window");
  });

  it("lists every prose field of a draft with its role and claim unit", () => {
    const fields = draftProse(validDraft());
    expect(fields).toHaveLength(2 + 2 + 6 + 4 + 1 + 1 + 4 + 1);
    expect(fields.filter((f) => f.role === "label").map((f) => f.path)).toEqual([
      "exhibits[0].title",
      "exhibits[1].title",
      "open_questions[0]",
    ]);
    expect(fields.filter((f) => f.role === "followup").map((f) => f.path)).toEqual([
      "next_moves[0].label",
      "next_moves[0].question",
      "next_moves[1].label",
      "next_moves[1].question",
    ]);
    const argument = fields.filter((f) => f.unit === "arguments[1]").map((f) => f.path);
    expect(argument).toEqual(["arguments[1].qloo_fact", "arguments[1].our_read"]);
    expect(fields.find((f) => f.path === "thesis")?.unit).toBe("thesis");
  });

  it("writes a field back into the draft it was read from", () => {
    const draft = validDraft();
    const fields = draftProse(draft);
    fields.find((f) => f.path === "arguments[2].our_read")?.set("Rewritten.");
    fields.find((f) => f.path === "open_questions[0]")?.set("Changed?");
    expect(draft.arguments[2]?.our_read).toBe("Rewritten.");
    expect(draft.open_questions).toEqual(["Changed?"]);
  });

  it("renders prose with no tokens at all for text that leaves the run", () => {
    expect(plainProse("Similarity {{M1}} [E1] over {{WINDOW}} [E3].", lookup, WINDOW)).toBe(
      "Similarity 0.62 over 2025-04-01..2025-09-30.",
    );
  });
});
