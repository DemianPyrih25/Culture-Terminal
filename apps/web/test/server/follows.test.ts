// Following edge cases (Part 10 open issue, Part 11): a re-run that stops at the picker is stored as the
// follow's pending run (PATCH), the API answers `pending` with the run, and a note clears it. Follow text
// never carries an entity id (R8). Memory store; invented runs, visitors and ids only.
import { describe, expect, it, vi } from "vitest";
import type { FollowListRow, FollowRow } from "@ct/db";

vi.mock("server-only", () => ({}));

const { setFollowLatestResponse, toFollow, visitorKeyOf, VISITOR_COOKIE } = await import("../../server/follows");
type FollowStore = import("../../server/follows").FollowStore;
type FollowRunFacts = import("../../server/follows").FollowRunFacts;

const COOKIE = "AbCdEfGhIjKlMnOpQrStUv";
const VISITOR = visitorKeyOf(COOKIE);
const QUESTION = "Is the Juniper Cola audience a moat or a niche?";
const AT = new Date(Date.UTC(2026, 9, 30, 10));

function run(id: string, status: FollowRunFacts["status"], question = QUESTION): FollowRunFacts {
  return { id, status, createdAt: AT, question, questionHash: `q1:${id}`, job: "brand_health", intent: null };
}

function store(runs: FollowRunFacts[]): FollowStore & { row: FollowRow; pendingWrites: (string | null)[] } {
  const row: FollowRow = {
    id: "follow-1",
    visitorKey: VISITOR,
    kind: "question",
    subjectKey: "question:q1",
    label: QUESTION,
    question: QUESTION,
    job: "brand_health",
    metro: null,
    latestRunId: "run-old-0001",
    pendingRunId: null,
    createdAt: AT,
    updatedAt: AT,
  };
  const pendingWrites: (string | null)[] = [];
  const listRow = (): FollowListRow => ({ ...row, latest: null });
  return {
    row,
    pendingWrites,
    list: async (key) => (key === VISITOR ? [listRow()] : []),
    get: async (key, id) => (key === VISITOR && id === row.id ? row : undefined),
    add: async () => ({ ok: true, follow: row, created: false }),
    remove: async () => true,
    setLatest: async (_key, _id, runId) => {
      row.latestRunId = runId;
      return true;
    },
    setPending: async (id, runId) => {
      if (id !== row.id) return false;
      pendingWrites.push(runId);
      row.pendingRunId = runId;
      return true;
    },
    run: async (id) => runs.find((r) => r.id === id) ?? null,
    resolves: async () => [],
  };
}

const patch = (body: unknown) =>
  new Request("http://localhost/api/follows", {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: `${VISITOR_COOKIE}=${COOKIE}` },
    body: JSON.stringify(body),
  });

describe("PATCH /api/follows and the pending re-run", () => {
  it("stores a re-run that stopped at the picker as pending and keeps the last note", async () => {
    const s = store([run("run-pick-0001", "needs_input")]);
    const res = await setFollowLatestResponse(patch({ id: "follow-1", runId: "run-pick-0001" }), { store: s, secureCookies: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { follow: { pending: unknown; latest: unknown } };
    expect(body.follow.pending).toEqual({ runId: "run-pick-0001" });
    expect(s.row.latestRunId).toBe("run-old-0001");
  });

  it("points at a note and clears the pick it waited on", async () => {
    const s = store([run("run-done-0001", "completed")]);
    s.row.pendingRunId = "run-pick-0001";
    const res = await setFollowLatestResponse(patch({ id: "follow-1", runId: "run-done-0001" }), { store: s, secureCookies: false });
    expect(res.status).toBe(200);
    expect(s.row).toMatchObject({ latestRunId: "run-done-0001", pendingRunId: null });
    expect(s.pendingWrites).toEqual([null]);
  });

  it("still refuses a run with no note and no pick, or one that asks another question", async () => {
    const s = store([run("run-failed-0001", "failed"), run("run-other-0001", "needs_input", "Who else drinks Juniper Cola?")]);
    expect((await setFollowLatestResponse(patch({ id: "follow-1", runId: "run-failed-0001" }), { store: s, secureCookies: false })).status).toBe(422);
    expect((await setFollowLatestResponse(patch({ id: "follow-1", runId: "run-other-0001" }), { store: s, secureCookies: false })).status).toBe(422);
    expect(s.pendingWrites).toEqual([]);
  });
});

describe("toFollow", () => {
  it("answers pending from the row and keeps entity ids out of the text", () => {
    const id = ["0a1b2c3d", "0000", "4000", "8000", "00000000aaaa"].join("-");
    const row: FollowListRow = {
      id: "follow-2",
      visitorKey: VISITOR,
      kind: "brand",
      subjectKey: "brand:juniper-cola",
      label: "Juniper Cola",
      question: QUESTION,
      job: "brand_health",
      metro: null,
      latestRunId: "run-done-0001",
      pendingRunId: "run-pick-0002",
      createdAt: AT,
      updatedAt: AT,
      latest: { runId: "run-done-0001", status: "completed", createdAt: AT, headline: `Stands apart from ${id}.`, tag: null, signal: "strong" },
    };
    const follow = toFollow(row);
    expect(follow.pending).toEqual({ runId: "run-pick-0002" });
    expect(follow.latest?.headline).toBe("Stands apart from «entity».");
    expect(toFollow({ ...row, pendingRunId: null }).pending).toBeNull();
  });
});
