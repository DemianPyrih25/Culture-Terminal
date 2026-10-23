// The Ask page as a state machine: preview answers (success, refusal, 429, 503, errors), the run body
// with the preview's token, and what the panel prints. Invented entities only.
import { compileMnemonic, JOB_PILLAR, METRO_LABEL, type Intent } from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ageText,
  askReducer,
  cacheLine,
  canRun,
  compiledMnemonic,
  estimateLine,
  INITIAL_ASK_STATE,
  matchProblems,
  messageParts,
  quotaText,
  readingGap,
  readPreviewResponse,
  runRequestBody,
  subjectsText,
  waitText,
  type AskState,
  type PreviewOutcome,
  type PreviewResponse,
} from "../../components/ask/ask-machine";
import {
  FIXTURE_AT,
  FIXTURE_HAVE,
  FIXTURE_PREVIEW,
  FIXTURE_PREVIEW_NO_CITY,
  FIXTURE_PREVIEW_ONE_NAME,
  FIXTURE_PREVIEW_PICK,
  FIXTURE_PREVIEW_UNMATCHED,
  FIXTURE_QUESTION,
  FIXTURE_REFUSAL,
} from "../../components/ask/fixtures";
import { JOB_LABEL } from "../../lib/brief/format";

type Understood = NonNullable<PreviewResponse["understood"]>;
type Mention = Intent["mentions"][number];
import { followsUp, type AskParent } from "../../components/ask/ask-panel";
import { startRun } from "../../lib/start-run";

const Q = FIXTURE_QUESTION;

function previewed(outcome: PreviewOutcome, question = Q): AskState {
  const loading = askReducer(INITIAL_ASK_STATE, { type: "preview", question });
  return askReducer(loading, { type: "previewed", question, outcome, at: FIXTURE_AT });
}

describe("readPreviewResponse", () => {
  it("reads a preview", () => {
    expect(readPreviewResponse(200, FIXTURE_PREVIEW)).toEqual({ kind: "ok", preview: FIXTURE_PREVIEW });
    expect(readPreviewResponse(200, FIXTURE_REFUSAL)).toEqual({ kind: "ok", preview: FIXTURE_REFUSAL });
  });

  it("never trusts a 200 that is not a preview", () => {
    for (const body of [null, {}, { ...FIXTURE_PREVIEW, estimate: null }, { ...FIXTURE_PREVIEW, understood: { job: "buy" } }]) {
      expect(readPreviewResponse(200, body)).toMatchObject({ kind: "error", retry: true });
    }
  });

  it("reads 429 as capped previews, with the wait and any brief that already answers", () => {
    const body = { error: "Question previews are paused for a while. You can still run the brief.", retry: false, alreadyHave: FIXTURE_HAVE };
    expect(readPreviewResponse(429, body, "900")).toEqual({
      kind: "limited",
      message: body.error,
      retryAfterS: 900,
      alreadyHave: FIXTURE_HAVE,
    });
    expect(readPreviewResponse(429, null, "soon")).toMatchObject({ kind: "limited", retryAfterS: null, alreadyHave: null });
  });

  it("reads 503 without retry as paused, and 503 with retry as a passing error", () => {
    const paused = { error: "Live analysis is paused. Recorded runs are still available.", retry: false, alreadyHave: FIXTURE_HAVE };
    expect(readPreviewResponse(503, paused)).toEqual({ kind: "paused", message: paused.error, alreadyHave: FIXTURE_HAVE });
    expect(readPreviewResponse(503, { error: "x", retry: false, alreadyHave: { runId: 4 } })).toMatchObject({ alreadyHave: null });
    expect(readPreviewResponse(503, { error: "The database is unavailable. Try again shortly.", retry: true })).toEqual({
      kind: "error",
      message: "The database is unavailable. Try again shortly.",
      retry: true,
    });
  });

  it("reads other failures as errors: retry for the network and 5xx, not for a bad request", () => {
    expect(readPreviewResponse(null, null)).toMatchObject({ kind: "error", retry: true });
    expect(readPreviewResponse(502, { error: "The question could not be read right now.", retry: true })).toMatchObject({
      kind: "error",
      retry: true,
    });
    expect(readPreviewResponse(400, { error: "Invalid preview request." })).toEqual({
      kind: "error",
      message: "Invalid preview request.",
      retry: false,
    });
    expect(readPreviewResponse(403, "<html>")).toMatchObject({ kind: "error", retry: false });
  });
});

describe("askReducer", () => {
  it("moves from loading to ready, and a ready reading can run with its token", () => {
    const loading = askReducer(INITIAL_ASK_STATE, { type: "preview", question: Q });
    expect(loading.phase).toEqual({ kind: "loading", question: Q });
    expect(canRun(loading)).toBe(false);
    const ready = previewed({ kind: "ok", preview: FIXTURE_PREVIEW });
    expect(ready.phase).toMatchObject({ kind: "ready", question: Q, at: FIXTURE_AT });
    expect(canRun(ready)).toBe(true);
    expect(runRequestBody(ready)).toEqual({ question: Q, previewToken: FIXTURE_PREVIEW.token });
    expect(runRequestBody(ready, "run-fixture-c3d4")).toEqual({
      question: Q,
      previewToken: FIXTURE_PREVIEW.token,
      parentRunId: "run-fixture-c3d4",
    });
  });

  it("never runs a refusal", () => {
    const refused = previewed({ kind: "ok", preview: FIXTURE_REFUSAL });
    expect(canRun(refused)).toBe(false);
    expect(runRequestBody(refused)).toBeNull();
    expect(askReducer(refused, { type: "run" })).toBe(refused);
    // The model declined to read it at all: no reading, no run.
    const declined = previewed({ kind: "ok", preview: { ...FIXTURE_PREVIEW, understood: null, token: null } });
    expect(canRun(declined)).toBe(false);
  });

  it("runs only a complete reading: never a head-to-head with one usable brand", () => {
    for (const preview of [FIXTURE_PREVIEW_ONE_NAME, FIXTURE_PREVIEW_UNMATCHED, FIXTURE_PREVIEW_NO_CITY]) {
      const short = previewed({ kind: "ok", preview });
      expect(canRun(short)).toBe(false);
      expect(runRequestBody(short)).toBeNull();
      expect(askReducer(short, { type: "run" })).toBe(short);
    }
    // A subject with more than one match is picked when the brief runs: it still runs.
    expect(canRun(previewed({ kind: "ok", preview: FIXTURE_PREVIEW_PICK }))).toBe(true);
  });

  it("runs a capped preview without a token, but never a paused service or an error", () => {
    const limited = previewed({ kind: "limited", message: "Previews are capped.", retryAfterS: 60, alreadyHave: null });
    expect(canRun(limited)).toBe(true);
    expect(runRequestBody(limited)).toEqual({ question: Q });
    const paused = previewed({ kind: "paused", message: "Paused.", alreadyHave: FIXTURE_HAVE });
    expect(paused.phase).toMatchObject({ kind: "paused", alreadyHave: FIXTURE_HAVE });
    expect(canRun(paused)).toBe(false);
    const failed = previewed({ kind: "error", message: "No connection.", retry: true });
    expect(failed.phase).toEqual({ kind: "error", question: Q, message: "No connection.", retry: true });
    expect(canRun(failed)).toBe(false);
  });

  it("drops a late answer for a question no longer being read", () => {
    const first = askReducer(INITIAL_ASK_STATE, { type: "preview", question: "Brand Alpha HLTH" });
    const second = askReducer(first, { type: "preview", question: Q });
    const late = askReducer(second, { type: "previewed", question: "Brand Alpha HLTH", outcome: { kind: "ok", preview: FIXTURE_PREVIEW }, at: 1 });
    expect(late).toBe(second);
    expect(askReducer(askReducer(second, { type: "clear" }), { type: "previewed", question: Q, outcome: { kind: "ok", preview: FIXTURE_PREVIEW }, at: 1 })).toEqual(
      INITIAL_ASK_STATE,
    );
  });

  it("starts once, and shows why a start was refused", () => {
    const ready = previewed({ kind: "ok", preview: FIXTURE_PREVIEW });
    const starting = askReducer(ready, { type: "run" });
    expect(starting.run).toEqual({ kind: "starting", message: null });
    expect(canRun(starting)).toBe(false);
    expect(askReducer(starting, { type: "run" })).toBe(starting);
    // While the server asks to wait, its word is kept; outside a start it is ignored.
    const waiting = askReducer(starting, { type: "runRetrying", message: "Too many runs are active. Try again shortly." });
    expect(waiting.run).toEqual({ kind: "starting", message: "Too many runs are active. Try again shortly." });
    expect(askReducer(ready, { type: "runRetrying", message: "Retrying…" })).toBe(ready);
    const failed = askReducer(starting, { type: "runFailed", message: "Live analysis is paused." });
    expect(failed.run).toEqual({ kind: "failed", message: "Live analysis is paused." });
    expect(canRun(failed)).toBe(true);
    // A new preview starts over.
    expect(askReducer(failed, { type: "preview", question: Q }).run).toEqual({ kind: "idle" });
  });
});

describe("the run request", () => {
  it("posts the question with the preview's token and the parent to POST /api/runs", async () => {
    const ready = previewed({ kind: "ok", preview: FIXTURE_PREVIEW });
    const body = runRequestBody(ready, "run-fixture-c3d4");
    const fetch = vi.fn(async () => Response.json({ runId: "run-fixture-e5f6" }, { status: 201 }));
    await expect(startRun(body, { fetch })).resolves.toEqual({ ok: true, runId: "run-fixture-e5f6" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/runs");
    expect(JSON.parse(String(init.body))).toEqual({
      question: Q,
      previewToken: FIXTURE_PREVIEW.token,
      parentRunId: "run-fixture-c3d4",
    });
  });

  it("names the parent only when the server will take it", () => {
    const parent = (blocked: AskParent["blocked"]): AskParent => ({ runId: "run-fixture-c3d4", question: "Who is the Brand Beta crowd?", blocked });
    expect(followsUp(parent(null))).toBe(true);
    for (const blocked of ["running", "test_run", "no_note", "unreadable"] as const) expect(followsUp(parent(blocked)), blocked).toBe(false);
    expect(followsUp(null)).toBe(false);
  });

  it("says what the server says while a start waits, and passes it on", async () => {
    let calls = 0;
    const fetch = vi.fn(async () =>
      ++calls === 1
        ? Response.json({ error: "Too many runs are active. Try again shortly.", retry: true }, { status: 429 })
        : Response.json({ runId: "run-fixture-e5f6" }, { status: 201 }),
    );
    const onRetry = vi.fn();
    await expect(startRun({ question: Q }, { fetch, onRetry, wait: async () => undefined })).resolves.toEqual({ ok: true, runId: "run-fixture-e5f6" });
    expect(onRetry).toHaveBeenCalledWith("Too many runs are active. Try again shortly.");
  });
});

describe("what the panel prints", () => {
  it("prints the estimate, the cache share and the quota", () => {
    expect(estimateLine(FIXTURE_PREVIEW.estimate)).toBe("≈19 data requests · ~45 s");
    expect(estimateLine({ networkCalls: 1, cachedCalls: 0, seconds: 30, quotaShare: 0 })).toBe("≈1 data request · ~30 s");
    expect(estimateLine({ networkCalls: 0, cachedCalls: 0, seconds: 0, quotaShare: 0 })).toBe("No data requests");
    expect(cacheLine(FIXTURE_PREVIEW.estimate)).toBe("≈7 served from cache · priors written before any data");
    expect(quotaText(0)).toBe("None of today's quota");
    expect(quotaText(0.0063)).toBe("<1% of today's quota");
    expect(quotaText(0.0104)).toBe("≈1% of today's quota");
    expect(quotaText(0.021)).toBe("≈2% of today's quota");
  });

  it("prints a brief's age against when the preview arrived", () => {
    expect(ageText(FIXTURE_HAVE.createdAt, FIXTURE_AT)).toBe("2h ago");
    expect(ageText("2026-07-06T11:59:40.000Z", FIXTURE_AT)).toBe("just now");
    expect(ageText("2026-07-06T11:48:00.000Z", FIXTURE_AT)).toBe("12 min ago");
    expect(ageText("2026-07-02T12:00:00.000Z", FIXTURE_AT)).toBe("4 days ago");
    expect(ageText("not a date", FIXTURE_AT)).toBe("");
  });

  it("splits a server message into a heading and its detail, so nothing is said twice", () => {
    expect(messageParts("Today's budget for live analysis is used up. Live runs resume at 00:00 UTC.")).toEqual({
      head: "Today's budget for live analysis is used up",
      rest: "Live runs resume at 00:00 UTC.",
    });
    expect(messageParts("Live analysis is unavailable: this server has no Anthropic API key.")).toEqual({
      head: "Live analysis is unavailable: this server has no Anthropic API key",
      rest: null,
    });
    expect(messageParts("Something went wrong")).toEqual({ head: "Something went wrong", rest: null });
    // A decimal is no sentence end; a question mark stays on its heading.
    expect(messageParts("Overlap was 0.5 today. Try again?")).toEqual({ head: "Overlap was 0.5 today", rest: "Try again?" });
    expect(messageParts("Why? Because.")).toEqual({ head: "Why?", rest: "Because." });
  });

  it("prints how long until previews resume", () => {
    expect(waitText(20)).toBe("under a minute");
    expect(waitText(900)).toBe("about 15 min");
    expect(waitText(61)).toBe("about 2 min");
    expect(waitText(7200)).toBe("about 2 h");
  });

  it("names the subjects, and every name that did not match exactly: the subject is picked, any other left out", () => {
    expect(subjectsText(FIXTURE_PREVIEW.understood!)).toBe("Juniper Cola, Brand Beta");
    expect(matchProblems(FIXTURE_PREVIEW.understood!)).toEqual([]);
    expect(matchProblems(FIXTURE_PREVIEW_UNMATCHED.understood!)).toEqual(["Brand Betta (brand): no exact match, left out"]);
    expect(matchProblems(FIXTURE_PREVIEW_PICK.understood!)).toEqual(["Junipr Cola (brand): more than one match, you will pick one"]);
  });
});

describe("readingGap", () => {
  const brand = (text: string, role: Mention["role"]): Mention => ({ text, entity_type: "brand", role, public_figure: false });
  const blank: Intent = {
    pillar: "investment",
    job: "brand_health",
    mentions: [],
    geo: { metro: null, area: null, unsupported_place: null },
    constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [] },
    safety: { allowed: true, category: null, reframe: null },
    assumptions: [],
    mnemonic: "",
  };
  /** The preview's reading of an intent, its mnemonic compiled by code as the server does. */
  const understood = (over: Partial<Intent>, match: "exact" | "not_found" = "exact"): Understood => {
    const intent = { ...blank, ...over };
    return {
      pillar: JOB_PILLAR[intent.job],
      job: intent.job,
      jobLabel: JOB_LABEL[intent.job],
      mnemonic: compileMnemonic(intent),
      mentions: intent.mentions.map((m, i) => ({
        text: m.text,
        type: m.entity_type,
        role: m.role,
        match: i === 0 ? "exact" : match,
        name: i === 0 || match === "exact" ? m.text : null,
      })),
      metros: intent.geo.metro ? [METRO_LABEL[intent.geo.metro]] : [],
      scope: "",
      lens: "",
    };
  };
  const austin = { metro: "austin" as const, area: null, unsupported_place: null };
  const concepts = (...c: string[]) => ({ ...blank.constraints, concepts: c });

  it("says what each job lacks, and never compiles a placeholder", () => {
    const short: Array<[Partial<Intent>, string]> = [
      [{ job: "head_to_head" }, "Two brands to compare"],
      [{ job: "head_to_head", mentions: [brand("Juniper Cola", "primary")] }, "A second brand to compare with Juniper Cola"],
      [{ job: "brand_health" }, "A brand to read"],
      [{ job: "sponsorship" }, "An artist to find sponsors for"],
      [{ job: "market_selection" }, "A brand or artist to launch or tour"],
      [{ job: "audience_discovery" }, "A brand, artist or show whose audience to read"],
      [{ job: "site_selection" }, "A concept to open and a city, Nashville or Austin"],
      [{ job: "site_selection", geo: austin }, "A concept to open, such as a listening bar"],
      [{ job: "site_selection", constraints: concepts("ramen counter") }, "A city, Nashville or Austin"],
      [{ job: "area_profile" }, "A neighbourhood and its city, Nashville or Austin"],
      [{ job: "tenant_mix", geo: austin }, "A neighbourhood in Austin"],
      [{ job: "area_profile", geo: { metro: null, area: "Riverside", unsupported_place: null } }, "The neighbourhood's city, Nashville or Austin"],
    ];
    for (const [over, need] of short) {
      const reading = understood(over);
      expect(reading.mnemonic, need).toMatch(/<[A-Z]+>/);
      expect(readingGap(reading)?.need, reading.mnemonic).toBe(need);
      expect(compiledMnemonic(reading), reading.mnemonic).toBeNull();
    }
  });

  it("finds nothing lacking in a complete reading of any job", () => {
    const complete: Array<Partial<Intent>> = [
      { job: "head_to_head", mentions: [brand("Juniper Cola", "primary"), brand("Brand Beta", "peer")] },
      { job: "brand_health", mentions: [brand("Juniper Cola", "primary")] },
      { job: "sponsorship", mentions: [{ text: "Artist Nova", entity_type: "artist", role: "primary", public_figure: true }] },
      { job: "market_selection", mentions: [brand("Juniper Cola", "primary")] },
      { job: "audience_discovery", mentions: [brand("Juniper Cola", "primary")] },
      { job: "site_selection", geo: austin, constraints: concepts("ramen counter") },
      { job: "area_profile", geo: { ...austin, area: "Riverside" } },
      { job: "tenant_mix", geo: { ...austin, area: "Riverside" } },
    ];
    for (const over of complete) {
      const reading = understood(over);
      expect(readingGap(reading), reading.mnemonic).toBeNull();
      expect(compiledMnemonic(reading)).toBe(reading.mnemonic);
    }
  });

  it("needs a second brand the run can use: one that matched, named as the one to compare", () => {
    const unmatched = understood({ job: "head_to_head", mentions: [brand("Juniper Cola", "primary"), brand("Brand Betta", "peer")] }, "not_found");
    expect(unmatched.mnemonic).toBe("JUNIPER COLA VS BRAND BETTA");
    expect(readingGap(unmatched)).toEqual({
      need: "A second brand to compare with Juniper Cola",
      hint: "Check the spelling of Brand Betta, or name another brand, then press ↵.",
    });
    expect(compiledMnemonic(unmatched)).toBeNull();
    const secondary = understood({ job: "head_to_head", mentions: [brand("Juniper Cola", "primary"), brand("Brand Beta", "secondary")] });
    expect(readingGap(secondary)?.hint).toBe("Ask it as “Juniper Cola vs Brand Beta” and press ↵.");
    expect(readingGap(understood({ job: "head_to_head", mentions: [brand("Juniper Cola", "primary")] }))?.hint).toBe(
      "Name it in the question and press ↵ to read it again.",
    );
  });
});
