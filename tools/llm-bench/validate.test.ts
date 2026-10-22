import { describe, expect, it } from "vitest";
import { validPlan, validReport } from "./test-utils";
import { checkPlan, checkReport } from "./validate";

describe("checkPlan and checkReport", () => {
  it("accept valid submissions on both levels", () => {
    expect(checkPlan(validPlan())).toMatchObject({ structural: true, limits: true, issues: [] });
    expect(checkReport(validReport())).toMatchObject({ structural: true, limits: true, issues: [] });
  });

  it("count a badly formed id as a limits issue the CHECKER can repair, not a strict-mode failure", () => {
    const plan = validPlan();
    const badPlan = { ...plan, hypotheses: plan.hypotheses.map((h, i) => (i === 0 ? { ...h, id: "Hyp-1" } : h)) };
    const p = checkPlan(badPlan);
    expect(p).toMatchObject({ structural: true, limits: false });
    expect(p.issues.join("\n")).toMatch(/^hypotheses\.0\.id: /m);
    expect(p.plan?.hypotheses[0]?.id).toBe("Hyp-1");

    const report = validReport();
    const r = checkReport({ ...report, arguments: report.arguments.map((a) => ({ ...a, metric_ids: ["metric one"] })) });
    expect(r).toMatchObject({ structural: true, limits: false });
    expect(r.report).not.toBeNull();
  });

  it("count a missing field or a wrong type as a strict-mode failure", () => {
    const noSteps: Record<string, unknown> = { ...validPlan() };
    delete noSteps.steps;
    expect(checkPlan(noSteps)).toMatchObject({ structural: false, plan: null });
    expect(checkReport({ ...validReport(), signal: "very strong" })).toMatchObject({ structural: false, report: null });
  });

  it("records a count limit, such as a single hypothesis, as a limits issue", () => {
    const plan = validPlan();
    expect(checkPlan({ ...plan, hypotheses: plan.hypotheses.slice(0, 1) })).toMatchObject({ structural: true, limits: false });
  });
});
