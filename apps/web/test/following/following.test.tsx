// Following (/following) in the browser: the subjects a note offers, the page model (latest note, day,
// re-run states), the list's states, the shared follows copy and pending re-runs, the Follow button's
// states and the page. No alerts, nothing compared with an earlier note. Invented brands and runs only.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Follow, Intent, ResolvedMention } from "@ct/contracts";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/following",
}));

const { default: FollowingPage, metadata } = await import("../../app/following/page");
const { findFollow, noteFollowOptions, noteSubjects, profileFollowOption, sameQuestion, clipLabel } = await import("../../components/following/subjects");
const { EMPTY_TEXT, followButtonModel, followRowModel, rerunEndedMessage, RERUN_IDLE } = await import("../../components/following/model");
const { FollowingView, FollowRow } = await import("../../components/following/following-view");
const { FollowButton, FollowMenu } = await import("../../components/following/follow-button");
const { FollowsStore, PENDING_RERUNS_SLOT, readPendingReruns, runStatus, writePendingRerun } = await import("../../components/following/client");

const html = renderToStaticMarkup;
const NOW = Date.parse("2026-10-26T15:00:00.000Z");

const resolve = (over: Partial<ResolvedMention> = {}): ResolvedMention => ({
  mention: "Juniper Cola",
  role: "primary",
  entityType: "brand",
  match: "exact",
  ref: "R1",
  name: "Juniper Cola",
  popularity: 0.4,
  disambiguation: null,
  alternatives: [],
  source: "gate",
  ...over,
});
const intentAt = (metro: string | null, area: string | null = null) => ({ geo: { metro, area } }) as unknown as Intent;

function follow(over: Partial<Follow> = {}): Follow {
  return {
    id: "follow-1",
    kind: "brand",
    subjectKey: "brand:juniper cola",
    label: "Juniper Cola",
    rerun: { question: "Who really competes with Juniper Cola?", job: "brand_health", metro: null },
    latest: {
      runId: "run-brand-0001",
      status: "completed",
      createdAt: "2026-10-25T10:00:00.000Z",
      headline: "Juniper Cola competes with craft sodas, not colas",
      tag: "Taste island",
      signal: "strong",
    },
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-25T10:00:00.000Z",
    ...over,
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

describe("what a note can be followed by", () => {
  it("offers the exact-matched primary brand, the map city and area, and the question, in that order", () => {
    const subjects = noteSubjects({ question: "Where in Austin should Juniper Cola open a pop-up on Maple Row?", job: "site_selection", intent: intentAt("austin", "Maple Row"), resolves: [resolve()] });
    expect(subjects.map((s) => [s.kind, s.label, s.subjectKey])).toEqual([
      ["brand", "Juniper Cola", "brand:juniper cola"],
      ["place", "Maple Row, Austin", "place:austin:maple row"],
      ["question", "Where in Austin should Juniper Cola open a pop-up on Maple Row?", null],
    ]);
    expect(subjects[0]?.rerun).toEqual({ question: "Where in Austin should Juniper Cola open a pop-up on Maple Row?", job: "site_selection", metro: "austin" });
  });

  it("offers no brand for an offered candidate, a peer or another type, and no place without a map city", () => {
    for (const r of [resolve({ match: "inexact", ref: null }), resolve({ role: "peer" }), resolve({ entityType: "artist" })]) {
      expect(noteSubjects({ question: "Q?", job: null, intent: intentAt(null), resolves: [r] }).map((s) => s.kind)).toEqual(["question"]);
    }
    expect(noteSubjects({ question: "  ", job: null, intent: null, resolves: [resolve()] })).toEqual([]);
  });

  it("builds the POST bodies from the run or the profile name, never a subject key", () => {
    const options = noteFollowOptions("run-brand-0001", { question: "Who competes with Juniper Cola?", job: "brand_health", intent: null, resolves: [resolve()] });
    expect(options.map((o) => o.create)).toEqual([
      { from: "run", runId: "run-brand-0001", kind: "brand" },
      { from: "run", runId: "run-brand-0001", kind: "question" },
    ]);
    const profile = profileFollowOption("Juniper Cola");
    expect(profile.create).toEqual({ from: "profile", name: "Juniper Cola" });
    expect(profile.subject).toMatchObject({ kind: "brand", subjectKey: "brand:juniper cola", rerun: { job: "brand_health", metro: null } });
  });

  it("finds a followed brand by its key and a followed question by its words", () => {
    const follows = [follow(), follow({ id: "follow-2", kind: "question", subjectKey: "question:q1:x", label: "Q", rerun: { question: "Who really competes with Juniper Cola?", job: null, metro: null } })];
    expect(findFollow(follows, profileFollowOption("juniper  cola").subject)?.id).toBe("follow-1");
    const [, question] = noteSubjects({ question: "who really competes with juniper cola?", job: null, intent: null, resolves: [resolve()] });
    expect(question && findFollow(follows, question)?.id).toBe("follow-2");
    expect(findFollow(follows, profileFollowOption("Aurora Footwear").subject)).toBeUndefined();
    expect(sameQuestion(" A  b? ", "a B?")).toBe(true);
    expect(clipLabel("word ".repeat(60)).length).toBeLessThanOrEqual(120);
  });
});

describe("the page model", () => {
  it("shows the latest note's verdict tag, its day and a link to the note", () => {
    const row = followRowModel(follow(), RERUN_IDLE, NOW, "UTC");
    expect(row).toMatchObject({ kindLabel: "Brand", label: "Juniper Cola", jobLabel: "Real competitors", rerunLabel: "Re-run" });
    expect(row.note).toMatchObject({ href: "/r/run-brand-0001", status: "done", text: "Taste island", day: "Yesterday" });
  });

  it("falls back to the signal, then the status, and links a running note to its workspace", () => {
    const latest = follow().latest!;
    expect(followRowModel(follow({ latest: { ...latest, tag: "nope 123" } }), RERUN_IDLE, NOW, "UTC").note?.text).toBe("Strong signal");
    const running = followRowModel(follow({ latest: { ...latest, status: "running", tag: null, signal: null } }), RERUN_IDLE, NOW, "UTC").note;
    expect(running).toMatchObject({ href: "/run/run-brand-0001", status: "working", text: "Working…" });
    const failed = followRowModel(follow({ latest: { ...latest, status: "failed", tag: null, signal: null } }), RERUN_IDLE, NOW, "UTC").note;
    expect(failed).toMatchObject({ status: "stopped", text: "Not finished" });
  });

  it("offers Run before the first note", () => {
    const row = followRowModel(follow({ latest: null }), RERUN_IDLE, NOW, "UTC");
    expect(row).toMatchObject({ note: null, rerunLabel: "Run" });
  });

  it("says a re-run that ended without a note keeps the last note", () => {
    for (const status of ["needs_input", "refused", "cancelled", "failed", null] as const) expect(rerunEndedMessage(status)).toContain("last note stays");
  });
});

describe("the list", () => {
  const ready = (follows: Follow[]) => ({ kind: "ready" as const, follows, max: 50 });

  it("shows skeletons, an error with Try again, and the empty well explaining how to follow", () => {
    expect(html(<FollowingView state={{ kind: "loading" }} now={NOW} />)).toContain("Loading what you follow");
    const error = html(<FollowingView state={{ kind: "error", message: "Your follows couldn't be loaded.", retry: true }} now={NOW} onRetry={() => {}} />);
    expect(error).toContain("Try again");
    const empty = html(<FollowingView state={ready([])} now={NOW} />);
    expect(empty).toContain(EMPTY_TEXT.replace("'", "&#x27;"));
    expect(empty).toContain("Ask a question");
  });

  it("lists each follow with its latest note, Re-run and Unfollow, and never a change or an alert", () => {
    const out = html(<FollowingView state={ready([follow(), follow({ id: "follow-2", latest: null, label: "Aurora Footwear", subjectKey: "brand:aurora footwear" })])} now={NOW} timeZone="UTC" />);
    expect(out).toContain("2 followed");
    expect(out).not.toContain("of 50");
    expect(out).toContain("Taste island");
    expect(out).toContain('href="/r/run-brand-0001"');
    expect(out).toContain("No note yet");
    expect(out).toContain("Re-run");
    expect(out).toContain("Unfollow");
    expect(out).not.toMatch(/vs yesterday|alert me|notify|▲|▼/i);
  });

  it("shows a running re-run with a link to it, and a refusal in the server's words", () => {
    const running = html(<FollowRow row={followRowModel(follow(), { kind: "running", runId: "run-new-0001" }, NOW, "UTC")} />);
    expect(running).toContain('href="/run/run-new-0001"');
    expect(running).toContain("Re-running");
    const error = html(<FollowRow row={followRowModel(follow(), { kind: "error", message: "You've reached this hour's limit." }, NOW, "UTC")} />);
    expect(error).toContain("this hour&#x27;s limit");
    const ended = html(<FollowRow row={followRowModel(follow(), { kind: "ended", runId: "run-new-0001", message: rerunEndedMessage("refused") }, NOW, "UTC")} />);
    expect(ended).toContain("Open the re-run");
  });
});

describe("the shared follows and pending re-runs", () => {
  it("loads once, upserts a new follow first and drops an unfollowed one", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return Response.json({ removed: true });
      if (init?.method === "POST") return Response.json({ follow: follow({ id: "follow-2", label: "Aurora Footwear" }), created: true }, { status: 201 });
      return Response.json({ follows: [follow()], max: 50 });
    });
    const store = new FollowsStore(fetch as unknown as typeof globalThis.fetch);
    await store.load();
    await store.load();
    expect(fetch).toHaveBeenCalledTimes(1);
    await store.follow({ from: "profile", name: "Aurora Footwear" }, fetch as unknown as typeof globalThis.fetch);
    const state = store.getSnapshot();
    expect(state.kind === "ready" && state.follows.map((f) => f.id)).toEqual(["follow-2", "follow-1"]);
    await store.unfollow("follow-1");
    const after = store.getSnapshot();
    expect(after.kind === "ready" && after.follows.map((f) => f.id)).toEqual(["follow-2"]);
  });

  it("says a refusal in the server's words and reads a failed list as retryable", async () => {
    const limit = vi.fn(async () => Response.json({ error: "You already follow 50.", code: "limit" }, { status: 409 }));
    const store = new FollowsStore(vi.fn(async () => Response.json({ error: "down" }, { status: 503 })) as unknown as typeof globalThis.fetch);
    await expect(store.follow({ from: "profile", name: "X" }, limit as unknown as typeof globalThis.fetch)).rejects.toMatchObject({ message: "You already follow 50.", code: "limit" });
    await store.load();
    expect(store.getSnapshot()).toMatchObject({ kind: "error", retry: true });
  });

  it("keeps pending re-runs per follow in storage, ignoring anything malformed", () => {
    const storage = memoryStorage();
    writePendingRerun("follow-1", "run-new-0001", storage);
    writePendingRerun("follow-2", "run-new-0002", storage);
    writePendingRerun("follow-1", null, storage);
    expect(readPendingReruns(storage)).toEqual({ "follow-2": "run-new-0002" });
    expect(readPendingReruns(memoryStorage({ [PENDING_RERUNS_SLOT]: "{not json" }))).toEqual({});
    expect(readPendingReruns(memoryStorage({ [PENDING_RERUNS_SLOT]: JSON.stringify({ a: "../etc" }) }))).toEqual({});
    expect(readPendingReruns(null)).toEqual({});
  });

  it("reads a run's status, null when it is gone and undefined when it cannot be read", async () => {
    const at = (res: Response | null) => vi.fn(async () => (res === null ? Promise.reject(new Error("offline")) : res)) as unknown as typeof globalThis.fetch;
    expect(await runStatus("run-new-0001", at(Response.json({ run: { status: "completed" }, state: {} })))).toBe("completed");
    expect(await runStatus("run-new-0001", at(Response.json({ error: "Run not found." }, { status: 404 })))).toBeNull();
    expect(await runStatus("run-new-0001", at(null))).toBeUndefined();
  });
});

describe("the Follow button", () => {
  const subject = profileFollowOption("Juniper Cola").subject;

  it("is a disabled Follow while the follows load, Follow when not followed, pressed Following when followed", () => {
    expect(followButtonModel(undefined, subject, "loading")).toMatchObject({ text: "Follow", disabled: true, pressed: false });
    expect(followButtonModel(undefined, subject, "ready")).toMatchObject({ text: "Follow", disabled: false, label: "Follow the brand Juniper Cola", followId: null });
    expect(followButtonModel(follow(), subject, "ready")).toMatchObject({ text: "Following", pressed: true, label: "Unfollow the brand Juniper Cola", followId: "follow-1" });
    expect(followButtonModel(follow(), subject, "busy")).toMatchObject({ loading: true, disabled: true });
  });

  it("renders on the server as a disabled Follow, and the note menu renders nothing without options", () => {
    const out = html(<FollowButton option={profileFollowOption("Juniper Cola")} />);
    expect(out).toContain("Follow");
    expect(out).toContain('aria-pressed="false"');
    expect(out).toContain("disabled");
    expect(html(<FollowMenu options={[]} />)).toBe("");
    expect(html(<FollowMenu options={noteFollowOptions("run-brand-0001", { question: "Q?", job: null, intent: null, resolves: [] })} />)).toContain("Follow");
  });
});

describe("the page", () => {
  it("renders the heading, the lead without alerts, and is not indexed", () => {
    const out = html(<FollowingPage />);
    expect(out).toContain("Following");
    expect(out).toContain("no alerts");
    expect(metadata.robots).toMatchObject({ index: false });
  });
});

describe("a re-run waiting for a pick (Part 10 follow edge case)", () => {
  it("says Needs your pick with a link to that run, and keeps the latest note", () => {
    const row = followRowModel(follow({ pending: { runId: "run-pick-0001" } }), RERUN_IDLE, NOW);
    expect(row.pending).toEqual({ href: "/run/run-pick-0001", label: "Needs your pick" });
    expect(row.note?.href).toBe("/r/run-brand-0001");
    const out = html(<FollowRow row={row} />);
    expect(out).toContain('data-follow-pending="true"');
    expect(out).toContain('href="/run/run-pick-0001"');
    expect(out).toContain("Needs your pick");
  });

  it("shows nothing extra without a pending pick, or while a new re-run is running", () => {
    expect(followRowModel(follow(), RERUN_IDLE, NOW).pending).toBeNull();
    expect(followRowModel(follow({ pending: null }), RERUN_IDLE, NOW).pending).toBeNull();
    const running = followRowModel(follow({ pending: { runId: "run-pick-0001" } }), { kind: "running", runId: "run-new-0002" }, NOW);
    expect(html(<FollowRow row={running} />)).not.toContain('data-follow-pending="true"');
  });
});
