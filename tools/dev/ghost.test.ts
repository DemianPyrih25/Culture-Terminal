// The GHOST attach CLI's pure parts: the command line, the checks on a run before anything is sent, the
// datasets the diff reads, the report as stored with GHOST on it, and the diff's summary line. No
// database, no network, no Anthropic key. Names are invented (D29).
import { GHOST_HONESTY_LINE, initialRunState, type DatasetEnvelope, type GhostDiff, type RunState } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { subsMap } from "../../packages/agent/test/ghost/support";
import { syntheticReport } from "./cli/fixtures";
import { memoryIo } from "./cli/io";
import { checkRun, diffLine, GHOST_USAGE, parseGhostArgs, runDatasets, runGhostCommand, withGhost } from "./ghost";

const RUN = "run-ghost-0001";
const report = syntheticReport(RUN);
const answer = { headline: "Brand Beta.", picks: { competitors: ["Brand Beta"], markets: [], neighbourhoods: [], tenants: [], partners: [] }, numeric_claims: [] };

function diff(items: GhostDiff["items"] = [], over: Partial<GhostDiff> = {}): GhostDiff {
  return { items, overlapAt5: 0.2, resolvability: 0.5, unsourcedNumericClaims: 2, meanPopularity: { ghost: null, qloo: null }, honestyLine: GHOST_HONESTY_LINE, ...over };
}

const state = (over: Partial<RunState> = {}): RunState => ({ ...initialRunState(RUN), ...over });

describe("the command line", () => {
  it("reads attach and its options", () => {
    expect(parseGhostArgs(["attach", RUN, "--yes"])).toEqual({ runId: RUN, yes: true, model: null, replace: false, mock: false, memory: false, tag: null });
    expect(parseGhostArgs(["attach", RUN, "-y", "--model", "claude-haiku-5-5", "--replace", "--mock-qloo", "--memory", "--tag", "ghost-test"])).toEqual({
      runId: RUN,
      yes: true,
      model: "claude-haiku-5-5",
      replace: true,
      mock: true,
      memory: true,
      tag: "ghost-test",
    });
    expect(parseGhostArgs(["--help"])).toBeNull();
  });

  it.each([
    [[], /name a command/],
    [["detach", RUN], /unknown command/],
    [["attach"], /needs a run id/],
    [["attach", "x/../y"], /not a run id/],
    [["attach", RUN, "extra"], /unexpected argument/],
    [["attach", RUN, "--model", "claude-opus-5-5"], /--model must be claude-sonnet-5-5 or claude-haiku-5-5/],
    [["attach", RUN, "--tag", " "], /--tag needs a non-empty value/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseGhostArgs(argv)).toThrow(message);
  });

  it("prints its usage for --help and for a bad command line, touching no database", async () => {
    const io = memoryIo();
    const unused = () => {
      throw new Error("no database for the command line");
    };
    expect(await runGhostCommand(["--help"], { env: {}, io, db: unused })).toBe(0);
    expect(io.text()).toBe(GHOST_USAGE);
    const bad = memoryIo();
    expect(await runGhostCommand(["attach"], { env: {}, io: bad, db: unused })).toBe(2);
    expect(bad.stderr.join("\n")).toContain("attach needs a run id");
  });
});

describe("the run", () => {
  const completed = { status: "completed" as const, ghost: null, report };

  it("takes a completed run's stored report, else the report.final event's", () => {
    expect(checkRun(completed, state(), false)).toEqual({ report });
    expect(checkRun({ ...completed, report: null }, state({ report }), false)).toEqual({ report });
  });

  it.each([
    [{ status: "running" as const }, "it is still running; GHOST is attached to completed briefs only"],
    [{ status: "needs_input" as const }, "it is waiting for a pick"],
    [{ status: "refused" as const }, "it ended refused"],
    [{ report: null }, "it stored no report"],
    [{ report: { ...report, job: undefined } }, "its report has no job"],
    [{ report: { ...report, verdict: null } }, "does not parse as the contracts' Report"],
    [{ ghost: { answer, diff: diff() } }, "it already has a GHOST column; --replace attaches a new one"],
  ])("refuses %j", (over, problem) => {
    const checked = checkRun({ ...completed, ...over }, state(), false);
    expect("problem" in checked && checked.problem).toContain(problem);
  });

  it("refuses a GHOST the events or the report already carry, unless it replaces it", () => {
    expect(checkRun(completed, state({ ghost: { answer, diff: diff() } }), false)).toHaveProperty("problem");
    expect(checkRun({ ...completed, report: { ...report, ghost: { answer, diff: diff() } } }, state(), false)).toHaveProperty("problem");
    expect(checkRun({ ...completed, ghost: { answer, diff: diff() } }, state({ ghost: { answer, diff: diff() } }), true)).toHaveProperty("report");
  });
});

describe("the datasets", () => {
  const d1 = subsMap("D1", ["R1", "Brand Alpha"], [["R2", "Brand Beta", 0.8]]);
  const d2 = subsMap("D2", ["R1", "Brand Alpha"], [["R3", "Brand Gamma", 0.6]]);
  const dataset = (d: DatasetEnvelope, inline: boolean) => ({ id: d.id, kind: d.kind, title: d.title, bytes: 1, data: inline ? d : null, seq: 1 });

  it("reads the ledger's envelopes first, then what the events streamed inline, skipping a row that does not parse", () => {
    const streamed = state({ datasets: { D1: dataset({ ...d1, title: "streamed" }, true), D2: dataset(d2, true) } });
    expect(runDatasets([{ payload: d1 }, { payload: { id: "D9" } }], streamed).map((d) => [d.id, d.title])).toEqual([
      ["D1", d1.title],
      ["D2", d2.title],
    ]);
    expect(runDatasets([], state({ datasets: { D1: dataset(d1, false) } }))).toEqual([]);
  });
});

describe("the stored report", () => {
  it("carries GHOST and the model it ran on, as the contracts define them", () => {
    const stored = withGhost(report, { answer, diff: diff() }, "claude-sonnet-5-5");
    expect(stored.ghost).toEqual({ answer, diff: diff() });
    expect(stored.receipt.models).toEqual({ ...report.receipt.models, ghost: "claude-sonnet-5-5" });
    expect(stored.verdict).toEqual(report.verdict);
  });

  it("summarises the diff in one line", () => {
    const item = (status: GhostDiff["items"][number]["status"], resolvesInQloo: boolean | null = null) => ({ name: "x", category: "competitors" as const, status, resolvesInQloo, ref: null });
    const line = diffLine(diff([item("both"), item("qloo_only"), item("qloo_only"), item("llm_only", true), item("llm_only", false), item("llm_only")], { resolvability: null }));
    expect(line).toBe("1 both · 2 only Qloo · 3 LLM only (1 resolve in Qloo, 1 do not, 1 not checked) · overlap@5 20% · resolvability not measured · 2 number(s) with no source");
  });
});
