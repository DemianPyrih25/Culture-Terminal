// /api/follows handlers without a database: an in-memory store stands in for the follows table and the
// runs it reads. Validation, the visitor cookie and per-browser isolation, dedupe, the limit, the human
// check, re-run pointing and unfollow. Invented runs and brands only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOLLOWS_PER_VISITOR_MAX, type Intent, type ResolvedMention } from "@ct/contracts";
import type { AddFollowResult, FollowListRow, FollowRow, NewFollow } from "@ct/db";
import type { HumanCheck } from "../../server/access";

vi.mock("server-only", () => ({}));

const { createFollowResponse, deleteFollowResponse, listFollowsResponse, setFollowLatestResponse, VISITOR_COOKIE, visitorKeyOf } = await import(
  "../../server/follows"
);
type FollowRunFacts = import("../../server/follows").FollowRunFacts;
type FollowStore = import("../../server/follows").FollowStore;

const A = "a".repeat(22);
const B = "b".repeat(22);
const MINTED = "m".repeat(22);

const intentAt = (metro: string | null, area: string | null = null) => ({ geo: { metro, area } }) as unknown as Intent;
const brandResolve = (name: string): ResolvedMention => ({
  mention: name,
  role: "primary",
  entityType: "brand",
  match: "exact",
  ref: "R1",
  name,
  popularity: 0.5,
  disambiguation: null,
  alternatives: [],
  source: "gate",
});

const RUNS: Record<string, FollowRunFacts & { resolves: ResolvedMention[] }> = {
  "run-brand-0001": {
    id: "run-brand-0001",
    status: "completed",
    createdAt: new Date("2026-10-20T10:00:00.000Z"),
    question: "Who really competes with Juniper Cola?",
    questionHash: "q1:hash-juniper",
    job: "brand_health",
    intent: intentAt(null),
    resolves: [brandResolve("Juniper Cola")],
  },
  "run-brand-0002": {
    id: "run-brand-0002",
    status: "completed",
    createdAt: new Date("2026-10-25T10:00:00.000Z"),
    question: "who really competes with   Juniper Cola?",
    questionHash: "q1:hash-juniper",
    job: "brand_health",
    intent: intentAt(null),
    resolves: [brandResolve("Juniper Cola")],
  },
  "run-place-0001": {
    id: "run-place-0001",
    status: "completed",
    createdAt: new Date("2026-10-21T10:00:00.000Z"),
    question: "What does Maple Row in Austin taste like?",
    questionHash: "q1:hash-maple",
    job: "area_profile",
    intent: intentAt("austin", "Maple Row"),
    resolves: [],
  },
  "run-working-0001": {
    id: "run-working-0001",
    status: "running",
    createdAt: new Date("2026-10-26T10:00:00.000Z"),
    question: "Who really competes with Juniper Cola?",
    questionHash: "q1:hash-juniper",
    job: null,
    intent: null,
    resolves: [],
  },
  "run-other-0001": {
    id: "run-other-0001",
    status: "completed",
    createdAt: new Date("2026-10-26T10:00:00.000Z"),
    question: "Who is the Artist Nova audience?",
    questionHash: "q1:hash-nova",
    job: "audience_discovery",
    intent: intentAt(null),
    resolves: [],
  },
};

/** The follows table and runs in memory, scoped by visitor key like the real repo. */
function memoryStore(): FollowStore & { rows: FollowRow[] } {
  const rows: FollowRow[] = [];
  let n = 0;
  const listRow = (row: FollowRow): FollowListRow => {
    const run = row.latestRunId ? RUNS[row.latestRunId] : undefined;
    return {
      ...row,
      latest: run ? { runId: run.id, status: run.status, createdAt: run.createdAt, headline: "A headline", tag: "Taste island", signal: "strong" } : null,
    };
  };
  return {
    rows,
    list: async (visitorKey) => rows.filter((r) => r.visitorKey === visitorKey).reverse().map(listRow),
    get: async (visitorKey, id) => rows.find((r) => r.visitorKey === visitorKey && r.id === id),
    add: async (input: NewFollow): Promise<AddFollowResult> => {
      const existing = rows.find((r) => r.visitorKey === input.visitorKey && r.kind === input.kind && r.subjectKey === input.subjectKey);
      if (existing) {
        Object.assign(existing, { label: input.label, question: input.question, job: input.job, metro: input.metro });
        if (input.latestRunId !== null) existing.latestRunId = input.latestRunId;
        return { ok: true, follow: existing, created: false };
      }
      if (rows.filter((r) => r.visitorKey === input.visitorKey).length >= FOLLOWS_PER_VISITOR_MAX) return { ok: false, reason: "limit" };
      const at = new Date(Date.UTC(2026, 9, 27, 0, 0, n));
      const row: FollowRow = { id: `follow-${++n}`, ...input, pendingRunId: null, createdAt: at, updatedAt: at };
      rows.push(row);
      return { ok: true, follow: row, created: true };
    },
    remove: async (visitorKey, id) => {
      const at = rows.findIndex((r) => r.visitorKey === visitorKey && r.id === id);
      if (at < 0) return false;
      rows.splice(at, 1);
      return true;
    },
    setLatest: async (visitorKey, id, runId) => {
      const row = rows.find((r) => r.visitorKey === visitorKey && r.id === id);
      if (!row) return false;
      row.latestRunId = runId;
      return true;
    },
    setPending: async (id, runId) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return false;
      row.pendingRunId = runId;
      return true;
    },
    run: async (runId) => {
      const run = RUNS[runId];
      if (!run) return null;
      return { id: run.id, status: run.status, createdAt: run.createdAt, question: run.question, questionHash: run.questionHash, job: run.job, intent: run.intent };
    },
    resolves: async (runId) => RUNS[runId]?.resolves ?? [],
  };
}

const passHuman = { checkHuman: async (): Promise<HumanCheck> => ({ ok: true, via: "off", setCookie: null }) };

let store: ReturnType<typeof memoryStore>;
const deps = () => ({ store, access: passHuman, secureCookies: false, mintVisitor: () => MINTED });

beforeEach(() => {
  store = memoryStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function req(method: string, body?: unknown, visitor?: string | null, headers: Record<string, string> = {}, url = "http://test.local/api/follows"): Request {
  return new Request(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(visitor ? { cookie: `${VISITOR_COOKIE}=${visitor}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function answer(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const post = async (body: unknown, visitor: string | null = A) => answer(await createFollowResponse(req("POST", body, visitor), deps()));
const list = async (visitor: string | null = A) => answer(await listFollowsResponse(req("GET", undefined, visitor), deps()));

describe("POST /api/follows", () => {
  it("follows a note's brand, place and question, reading each from the run", async () => {
    const brand = await post({ from: "run", runId: "run-brand-0001", kind: "brand" });
    expect(brand.status).toBe(201);
    expect(brand.body).toMatchObject({
      created: true,
      follow: {
        kind: "brand",
        subjectKey: "brand:juniper cola",
        label: "Juniper Cola",
        rerun: { question: "Who really competes with Juniper Cola?", job: "brand_health", metro: null },
        latest: { runId: "run-brand-0001", status: "completed", tag: "Taste island", signal: "strong" },
      },
    });
    const place = await post({ from: "run", runId: "run-place-0001", kind: "place" });
    expect(place.body).toMatchObject({ follow: { kind: "place", subjectKey: "place:austin:maple row", label: "Maple Row, Austin", rerun: { metro: "austin", job: "area_profile" } } });
    const question = await post({ from: "run", runId: "run-place-0001", kind: "question" });
    expect(question.body).toMatchObject({ follow: { kind: "question", subjectKey: "question:q1:hash-maple", label: "What does Maple Row in Austin taste like?" } });
    expect((await list()).body.follows).toHaveLength(3);
  });

  it("follows a profile's brand with the brand-health re-run and no note yet", async () => {
    const res = await post({ from: "profile", name: "  Juniper Cola " });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ follow: { kind: "brand", subjectKey: "brand:juniper cola", label: "Juniper Cola", latest: null, rerun: { job: "brand_health" } } });
    expect((res.body.follow as { rerun: { question: string } }).rerun.question).toContain("Juniper Cola");
  });

  it("keeps one follow per subject: following again refreshes it (200), and a profile follow joins a note's", async () => {
    await post({ from: "run", runId: "run-brand-0001", kind: "brand" });
    const again = await post({ from: "profile", name: "juniper cola" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, follow: { latest: { runId: "run-brand-0001" } } });
    const newer = await post({ from: "run", runId: "run-brand-0002", kind: "brand" });
    expect(newer.body).toMatchObject({ created: false, follow: { latest: { runId: "run-brand-0002" } } });
    // Following again from the older note keeps the newer one.
    const older = await post({ from: "run", runId: "run-brand-0001", kind: "brand" });
    expect(older.body).toMatchObject({ created: false, follow: { latest: { runId: "run-brand-0002" } } });
    expect(store.rows).toHaveLength(1);
  });

  it("does not point a follow at a run without a note", async () => {
    const res = await post({ from: "run", runId: "run-working-0001", kind: "question" });
    expect(res.body).toMatchObject({ follow: { latest: null } });
  });

  it("refuses a run without that subject (422), an unknown run (404) and bad bodies (400, 415, 403)", async () => {
    expect(await post({ from: "run", runId: "run-place-0001", kind: "brand" })).toMatchObject({ status: 422, body: { code: "no_subject" } });
    expect(await post({ from: "run", runId: "run-brand-0001", kind: "place" })).toMatchObject({ status: 422, body: { code: "no_subject" } });
    expect(await post({ from: "run", runId: "run-missing-0001", kind: "question" })).toMatchObject({ status: 404, body: { code: "not_found" } });
    for (const bad of [{}, { from: "run", runId: "x", kind: "brand" }, { from: "run", runId: "run-brand-0001", kind: "artist" }, { from: "profile", name: "" }]) {
      expect((await post(bad)).status).toBe(400);
    }
    // A client cannot choose the subject key.
    await post({ from: "profile", name: "Juniper Cola", subjectKey: "brand:something else" });
    expect(store.rows[0]?.subjectKey).toBe("brand:juniper cola");
    const text = await createFollowResponse(req("POST", "{}", A, { "Content-Type": "text/plain" }), deps());
    expect(text.status).toBe(415);
    const cross = await createFollowResponse(req("POST", { from: "profile", name: "Juniper Cola" }, A, { "sec-fetch-site": "cross-site" }), deps());
    expect(cross.status).toBe(403);
    const big = await createFollowResponse(req("POST", JSON.stringify({ from: "profile", name: "x".repeat(5000) }), A), deps());
    expect(big.status).toBe(413);
  });

  it("asks for the human check like a live run, and passes the token on", async () => {
    const checkHuman = vi.fn(async (_r: Request | undefined, token: string | null | undefined): Promise<HumanCheck> =>
      token === "tok-1" ? { ok: true, via: "token", setCookie: "ct_human=1; Path=/" } : { ok: false, kind: "missing" },
    );
    const refused = await answer(await createFollowResponse(req("POST", { from: "profile", name: "Juniper Cola" }), { ...deps(), access: { checkHuman } }));
    expect(refused).toMatchObject({ status: 403, body: { turnstile: true } });
    expect(store.rows).toHaveLength(0);
    const res = await createFollowResponse(req("POST", { from: "profile", name: "Juniper Cola", turnstileToken: "tok-1" }), { ...deps(), access: { checkHuman } });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-human-check")).toBe("passed");
    expect(res.headers.get("set-cookie")).toContain("ct_human=1");
  });

  it("mints a visitor cookie for a new browser and stores only its hash", async () => {
    const res = await createFollowResponse(req("POST", { from: "profile", name: "Juniper Cola" }, null), deps());
    expect(res.status).toBe(201);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${VISITOR_COOKIE}=${MINTED}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(store.rows[0]?.visitorKey).toBe(visitorKeyOf(MINTED));
    expect(store.rows[0]?.visitorKey).not.toContain(MINTED);
    expect((await list(MINTED)).body.follows).toHaveLength(1);
  });

  it("refuses a follow past the limit with a plain message (409)", async () => {
    for (let i = 0; i < FOLLOWS_PER_VISITOR_MAX; i++) await post({ from: "profile", name: `Brand ${i}` });
    const res = await post({ from: "profile", name: "One Too Many" });
    expect(res).toMatchObject({ status: 409, body: { code: "limit" } });
    expect(String(res.body.error)).toContain(String(FOLLOWS_PER_VISITOR_MAX));
  });
});

describe("GET /api/follows", () => {
  it("answers an empty list to a browser without a cookie, and never another browser's follows", async () => {
    expect(await list(null)).toEqual({ status: 200, body: { follows: [], max: FOLLOWS_PER_VISITOR_MAX } });
    await post({ from: "profile", name: "Juniper Cola" }, A);
    await post({ from: "profile", name: "Aurora Footwear" }, B);
    const mine = await list(A);
    expect((mine.body.follows as { label: string }[]).map((f) => f.label)).toEqual(["Juniper Cola"]);
    expect((await list("not-a-valid-cookie")).body.follows).toEqual([]);
  });

  it("lists newest first", async () => {
    await post({ from: "profile", name: "Juniper Cola" });
    await post({ from: "profile", name: "Aurora Footwear" });
    expect(((await list()).body.follows as { label: string }[]).map((f) => f.label)).toEqual(["Aurora Footwear", "Juniper Cola"]);
  });
});

describe("PATCH /api/follows", () => {
  const patch = async (body: unknown, visitor: string | null = A) => answer(await setFollowLatestResponse(req("PATCH", body, visitor), deps()));

  it("points a follow at its finished re-run", async () => {
    const { body } = await post({ from: "run", runId: "run-brand-0001", kind: "question" });
    const id = (body.follow as { id: string }).id;
    expect(await patch({ id, runId: "run-brand-0002" })).toMatchObject({ status: 200, body: { follow: { id, latest: { runId: "run-brand-0002" } } } });
  });

  it("keeps the last note for a run without one, another question, an unknown run or another browser's follow", async () => {
    const { body } = await post({ from: "run", runId: "run-brand-0001", kind: "question" });
    const id = (body.follow as { id: string }).id;
    expect(await patch({ id, runId: "run-working-0001" })).toMatchObject({ status: 422, body: { code: "invalid" } });
    expect(await patch({ id, runId: "run-other-0001" })).toMatchObject({ status: 422, body: { code: "invalid" } });
    expect(await patch({ id, runId: "run-missing-0001" })).toMatchObject({ status: 404 });
    expect(await patch({ id, runId: "run-brand-0002" }, B)).toMatchObject({ status: 404, body: { code: "not_found" } });
    expect(await patch({ id, runId: "run-brand-0002" }, null)).toMatchObject({ status: 404 });
    expect(await patch({ id })).toMatchObject({ status: 400 });
    expect(store.rows[0]?.latestRunId).toBe("run-brand-0001");
  });
});

describe("DELETE /api/follows", () => {
  it("unfollows by JSON body or ?id=, only this browser's follow", async () => {
    const one = await post({ from: "profile", name: "Juniper Cola" });
    const two = await post({ from: "profile", name: "Aurora Footwear" });
    const id1 = (one.body.follow as { id: string }).id;
    const id2 = (two.body.follow as { id: string }).id;
    expect(await answer(await deleteFollowResponse(req("DELETE", { id: id1 }, B), deps()))).toMatchObject({ status: 404 });
    expect(await answer(await deleteFollowResponse(req("DELETE", { id: id1 }, A), deps()))).toEqual({ status: 200, body: { removed: true } });
    expect(await answer(await deleteFollowResponse(req("DELETE", { id: id1 }, A), deps()))).toMatchObject({ status: 404, body: { code: "not_found" } });
    const byQuery = await deleteFollowResponse(req("DELETE", undefined, A, {}, `http://test.local/api/follows?id=${id2}`), deps());
    expect(byQuery.status).toBe(200);
    expect(await answer(await deleteFollowResponse(req("DELETE", undefined, A), deps()))).toMatchObject({ status: 400 });
    expect(store.rows).toHaveLength(0);
  });
});
