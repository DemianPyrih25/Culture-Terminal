// ASSEMBLE when the Taste Position card cannot be built: the note ships without the card and says
// so, instead of the run failing. The fake ANALYST over the mock transport; invented entities only (D29).
import { Report, type EventInput } from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import { POSITION_FAILED } from "../../src/report/position";
import { planCall, reportWithoutFollowup, respond, run } from "./support";

const card = vi.hoisted(() => ({ fail: false }));

vi.mock("@ct/quant", async (importOriginal) => {
  const quant = await importOriginal<typeof import("@ct/quant")>();
  return {
    ...quant,
    buildPosition: (...args: Parameters<typeof quant.buildPosition>) => {
      if (card.fail) throw new Error("the card's axes did not parse");
      return quant.buildPosition(...args);
    },
  };
});

/** Turn 1: the plan; turn 2: the report on the scan's evidence, again after the follow-up nudge. */
const script = [respond([planCall()]), ...reportWithoutFollowup()];

const kinds = (events: readonly EventInput[]) =>
  events.flatMap((e) => (e.type === "dataset.ready" ? [e.kind] : []));

describe("the Taste Position card at ASSEMBLE", () => {
  it("follows the Scorecard when it builds", async () => {
    card.fail = false;
    const { result, events } = await run({ stream: script });
    expect(result.status).toBe("completed");
    expect(kinds(events).slice(-2)).toEqual(["Scorecard", "Position"]);
    expect(Report.parse(result.report).exhibits[1]?.kind).toBe("Position");
  });

  it("is left out, with a limitation, when it cannot be built; the note still completes", async () => {
    card.fail = true;
    try {
      const { result, events } = await run({ stream: script });
      expect(result.status).toBe("completed");
      expect(result.reason).toBeNull();
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(kinds(events)).not.toContain("Position");
      const report = Report.parse(result.report);
      expect(report.incomplete).toBe(false);
      expect(report.exhibits[0]?.kind).toBe("Scorecard");
      expect(report.exhibits.map((x) => x.kind)).not.toContain("Position");
      expect(report.limitations.map((l) => l.text)).toContainEqual(expect.stringContaining(`${POSITION_FAILED}: the card's axes did not parse`));
    } finally {
      card.fail = false;
    }
  });
});
