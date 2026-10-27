// The working view's steps (lib/brief/steps): which step each event moves, the status title and its job
// phrase, how the question was read, what the run noticed, and the short timer. The sample run is invented (D29).
import { describe, expect, it, vi } from "vitest";
import { Job } from "@ct/contracts";
import { formatClockShort } from "../../lib/brief/format";
import {
  JOB_ACTIVE_PHRASE,
  NOTICED_MAX,
  noticed,
  readingAs,
  refusalSentence,
  replayTime,
  stepStates,
  WORKING_JOB_LABEL,
  workingProgress,
  workingTime,
} from "../../lib/brief/steps";
import { before, events, plus, stateOf, upTo } from "./support";

vi.mock("server-only", () => ({}));

const SAMPLE = events("brand-health");

const states = (list: Parameters<typeof stateOf>[0]) => stepStates(stateOf(list));

describe("the five steps", () => {
  it("reads the question from run.created and finds the name once CLERK has read it", () => {
    expect(states(upTo(SAMPLE, "run.created"))).toEqual({ read: "active", find: "pending", pull: "pending", write: "pending", check: "pending" });
    const read = workingProgress(stateOf(upTo(SAMPLE, "clerk")));
    expect(read.steps.map((s) => [s.key, s.state])).toEqual([
      ["read", "done"],
      ["find", "active"],
      ["pull", "pending"],
      ["write", "pending"],
      ["check", "pending"],
    ]);
    expect(read.title).toBe("Finding Juniper Cola in Qloo");
  });

  it("names the primary in the past tense once resolved, and pulls data from the first tool", () => {
    const found = workingProgress(stateOf(upTo(SAMPLE, "resolve")));
    expect(found.steps[1]).toMatchObject({ state: "done", label: "Found Juniper Cola in Qloo" });
    const pulling = workingProgress(stateOf(upTo(SAMPLE, "tool.start")));
    expect(pulling.steps[2]).toMatchObject({ state: "active", label: "Pulling taste data" });
    // The status title is the job's phrase while the data is pulled.
    expect(pulling.title).toBe("Comparing audiences");
    expect(pulling.announcement).toBe("Pulling taste data");
  });

  it("writes once the tools are done, checks from the draft and is done on a passing check", () => {
    const drafting = workingProgress(stateOf(before(SAMPLE, "report.draft")));
    expect(drafting.steps.map((s) => s.state)).toEqual(["done", "done", "done", "active", "pending"]);
    expect(drafting.title).toBe("Writing the answer");
    const checking = workingProgress(stateOf(upTo(SAMPLE, "report.draft")));
    expect(checking.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done", "active"]);
    expect(checking.title).toBe("Checking every number");
    expect(states(upTo(SAMPLE, "validation")).check).toBe("done");
  });

  it("keeps the check active while a failing check sends the draft back", () => {
    const sentBack = plus(upTo(SAMPLE, "report.draft"), {
      type: "validation",
      ok: false,
      attempt: 1,
      issues: [],
      numbersTraced: { traced: 20, total: 25 },
      adviceTerms: 0,
    });
    expect(states(sentBack).check).toBe("active");
  });

  it("only moves forward, event by event", () => {
    let furthest = -1;
    for (let i = 1; i <= SAMPLE.length; i++) {
      const steps = workingProgress(stateOf(SAMPLE.slice(0, i))).steps;
      const reached = steps.findLastIndex((s) => s.state !== "pending");
      expect(reached).toBeGreaterThanOrEqual(furthest);
      furthest = reached;
      for (const [j, s] of steps.entries()) if (j < reached) expect(s.state, `event ${i}, step ${j}`).toBe("done");
    }
  });

  it("has a status phrase and a label for every job", () => {
    for (const job of Job.options) {
      expect(JOB_ACTIVE_PHRASE[job]).toMatch(/^[A-Z][a-z]/);
      expect(WORKING_JOB_LABEL[job]).toMatch(/^[A-Z]/);
    }
    expect(WORKING_JOB_LABEL.brand_health).toBe("Real competitors");
    expect(WORKING_JOB_LABEL.area_profile).toBe("What an area is like");
  });
});

describe("the progress card's lines", () => {
  it("reads the question as the job and the names matched", () => {
    expect(readingAs(stateOf(upTo(SAMPLE, "run.created")))).toBeNull();
    expect(readingAs(stateOf(upTo(SAMPLE, "resolve")))).toBe("Real competitors · Juniper Cola");
    expect(readingAs(stateOf(upTo(SAMPLE, "resolve", 2)))).toMatch(/^Real competitors · Juniper Cola and \d+ similar brands$/);
  });

  it("notes the finding that made the run look closer, once it pivots", () => {
    expect(noticed(stateOf(before(SAMPLE, "pivot")))).toBeNull();
    const line = noticed(stateOf(upTo(SAMPLE, "pivot")));
    expect(line).toMatch(/^Noticed: Granite Outfitters .* peer\. Looking closer\.$/);
    expect(line).not.toContain("..");
  });

  it("leaves out a finding too long for one line", () => {
    const state = stateOf(upTo(SAMPLE, "pivot"));
    const long = { ...state, findings: state.findings.map((f) => ({ ...f, text: "x".repeat(NOTICED_MAX + 1) })) };
    expect(noticed(long)).toBeNull();
  });

  it("prints the time as the lane's estimate and m:ss, and a replay's place in the recording", () => {
    const state = stateOf(upTo(SAMPLE, "run.created"));
    expect(workingTime(state, 6_400)).toBe("Usually under a minute · 0:06");
    expect(workingTime({ ...state, lane: "judge" }, 71_000)).toBe("Usually 1–2 minutes · 1:11");
    expect(replayTime(12_000, 26_000)).toBe("Recording · 0:12 of 0:26");
    expect(replayTime(3_000, null)).toBe("Recording · 0:03");
  });

  it("formats the short clock", () => {
    expect(formatClockShort(0)).toBe("0:00");
    expect(formatClockShort(6_999)).toBe("0:06");
    expect(formatClockShort(725_000)).toBe("12:05");
    expect(formatClockShort(3_723_000)).toBe("1:02:03");
    expect(formatClockShort(-5)).toBe("0:00");
  });

  it("says what a refusal declines in one sentence, never investment advice", () => {
    expect(refusalSentence("political_targeting")).toBe("We don't answer political targeting questions.");
    expect(refusalSentence(null)).toBe("We don't answer this kind of question.");
    expect(refusalSentence("financial_advice")).toMatch(/buy, sell or price advice/);
  });
});
