// The question box as a state machine: preview answers (success, refusal, 429, 503, errors), what
// follows a preview with no confirm step (open, run, show), the run body with the preview's token, and
// the inline state's words. Invented entities only.
import { compileMnemonic, JOB_PILLAR, METRO_LABEL, type Intent } from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  askNotice,
  askReducer,
  askStatusText,
  canRun,
  INITIAL_ASK_STATE,
  isBusy,
  nextStep,
  pausedText,
  readingGap,
  readPreviewResponse,
  refusalText,
  reopenTime,
  runRequestBody,
  STILL_OPEN,
  waitText,
  type AskState,
  type PreviewOutcome,
  type PreviewResponse,
} from "../../components/ask/ask-machine";
import { followsUp, type AskParent } from "../../components/ask/ask-parent";
import {
  FIXTURE_AT,
  FIXTURE_HAVE,
  FIXTURE_PAUSE,
  FIXTURE_PAUSED_MESSAGE,
  FIXTURE_PREVIEW,
  FIXTURE_PREVIEW_HAVE,
  FIXTURE_PREVIEW_NO_CITY,
  FIXTURE_PREVIEW_ONE_NAME,
  FIXTURE_PREVIEW_PICK,
  FIXTURE_PREVIEW_UNMATCHED,
  FIXTURE_QUESTION,
  FIXTURE_REFUSAL,
} from "../../components/ask/fixtures";
import { JOB_LABEL } from "../../lib/brief/format";
import { startRun } from "../../lib/start-run";

/** The 13 map cities a place question can name, A to Z (D28). */
const CITIES = "Atlanta, Austin, Boston, Chicago, Dallas, Denver, Houston, Los Angeles, Miami, Nashville, New York City, San Francisco or Seattle";
const CITIES_TEXT = `Add the city: ${CITIES}.`;

type Understood = NonNullable<PreviewResponse["understood"]>;
type Mention = Intent["mentions"][number];

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
    expect(readPreviewResponse(503, { error: "We can't take new questions right now. Please try again in a moment.", retry: true })).toEqual({
      kind: "error",
      message: "We can't take new questions right now. Please try again in a moment.",
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

describe("what follows a preview", () => {
  it("runs a complete reading at once, with no confirm step", () => {
    expect(nextStep(previewed({ kind: "ok", preview: FIXTURE_PREVIEW }))).toEqual({ kind: "run" });
    // A subject with more than one match is picked once the run starts: it still runs.
    expect(nextStep(previewed({ kind: "ok", preview: FIXTURE_PREVIEW_PICK }))).toEqual({ kind: "run" });
    // Capped previews still run, without a token.
    expect(nextStep(previewed({ kind: "limited", message: "Capped.", retryAfterS: 60, alreadyHave: null }))).toEqual({ kind: "run" });
  });

  it("opens the answer the visitor already has instead of asking again, even while paused", () => {
    expect(nextStep(previewed({ kind: "ok", preview: FIXTURE_PREVIEW_HAVE }))).toEqual({ kind: "open", runId: FIXTURE_HAVE.runId });
    expect(nextStep(previewed({ kind: "paused", message: FIXTURE_PAUSED_MESSAGE, alreadyHave: FIXTURE_HAVE }))).toEqual({
      kind: "open",
      runId: FIXTURE_HAVE.runId,
    });
    // Never past a refusal.
    expect(nextStep(previewed({ kind: "ok", preview: { ...FIXTURE_REFUSAL, alreadyHave: FIXTURE_HAVE } }))).toEqual({ kind: "show" });
  });

  it("stays and shows the state for a refusal, a missing part, a pause and an error", () => {
    for (const outcome of [
      { kind: "ok", preview: FIXTURE_REFUSAL },
      { kind: "ok", preview: FIXTURE_PREVIEW_ONE_NAME },
      { kind: "ok", preview: { ...FIXTURE_PREVIEW, understood: null, token: null } },
      { kind: "paused", message: FIXTURE_PAUSED_MESSAGE, alreadyHave: null },
      { kind: "error", message: "No connection.", retry: true },
    ] as PreviewOutcome[]) {
      expect(nextStep(previewed(outcome)), outcome.kind).toEqual({ kind: "show" });
    }
  });

  it("is busy while the question is read and while the run starts", () => {
    expect(isBusy(INITIAL_ASK_STATE)).toBe(false);
    expect(isBusy(askReducer(INITIAL_ASK_STATE, { type: "preview", question: Q }))).toBe(true);
    const ready = previewed({ kind: "ok", preview: FIXTURE_PREVIEW });
    expect(isBusy(ready)).toBe(false);
    expect(isBusy(askReducer(ready, { type: "run" }))).toBe(true);
  });
});

describe("the inline state under the box", () => {
  it("says nothing while idle, while reading and while a complete reading starts its run", () => {
    expect(askNotice(INITIAL_ASK_STATE)).toBeNull();
    expect(askNotice(askReducer(INITIAL_ASK_STATE, { type: "preview", question: Q }))).toBeNull();
    const ready = previewed({ kind: "ok", preview: FIXTURE_PREVIEW });
    expect(askNotice(ready)).toBeNull();
    expect(askNotice(askReducer(ready, { type: "run" }))).toBeNull();
  });

  it("refuses in one sentence, with the reframe to ask instead", () => {
    expect(askNotice(previewed({ kind: "ok", preview: FIXTURE_REFUSAL }))).toEqual({
      kind: "refused",
      text: "We don't answer political targeting questions. Try this instead:",
      reframe: FIXTURE_REFUSAL.refusal!.reframe,
    });
    const bare = { ...FIXTURE_REFUSAL, refusal: { ...FIXTURE_REFUSAL.refusal!, reframe: "  " } };
    expect(askNotice(previewed({ kind: "ok", preview: bare }))).toEqual({
      kind: "refused",
      text: "We don't answer political targeting questions.",
      reframe: null,
    });
    expect(refusalText(null, false)).toBe("We can't answer that question as asked.");
    expect(refusalText("financial_advice", true)).toBe("We don't give investment advice. Try this instead:");
  });

  it("asks for what the reading lacks, in one sentence", () => {
    expect(askNotice(previewed({ kind: "ok", preview: FIXTURE_PREVIEW_ONE_NAME }))).toEqual({
      kind: "needs_input",
      text: "Add a second brand to compare with Juniper Cola.",
    });
    expect(askNotice(previewed({ kind: "ok", preview: FIXTURE_PREVIEW_UNMATCHED }))).toEqual({
      kind: "needs_input",
      text: `We couldn't find "Brand Betta". Check the spelling, or name another brand to compare.`,
    });
    expect(askNotice(previewed({ kind: "ok", preview: FIXTURE_PREVIEW_NO_CITY }))?.text).toBe(CITIES_TEXT);
    expect(askNotice(previewed({ kind: "ok", preview: { ...FIXTURE_PREVIEW, understood: null } }))?.kind).toBe("needs_input");
  });

  it("pauses with the reopen time in the visitor's zone, before anything is sent", () => {
    expect(askNotice(INITIAL_ASK_STATE, FIXTURE_PAUSE, "UTC")).toEqual({
      kind: "paused",
      text: `New questions reopen at 8:00 pm your time. ${STILL_OPEN}`,
    });
    expect(reopenTime("2026-07-06T20:00:00.000Z", "America/Chicago")).toBe("3:00 pm");
    expect(reopenTime("2026-07-06T09:05:00.000Z", "UTC")).toBe("9:05 am");
    expect(reopenTime("not a time")).toBeNull();
    expect(reopenTime(null)).toBeNull();
  });

  it("falls back on the server's message when it does not say when", () => {
    const paused = previewed({ kind: "paused", message: FIXTURE_PAUSED_MESSAGE, alreadyHave: null });
    expect(askNotice(paused)).toEqual({ kind: "paused", text: `${FIXTURE_PAUSED_MESSAGE} ${STILL_OPEN}` });
    expect(pausedText(null, "Live analysis is paused", "UTC")).toBe(`Live analysis is paused. ${STILL_OPEN}`);
    expect(pausedText(null, null)).toBe(`New questions are paused for now. ${STILL_OPEN}`);
  });

  it("offers Try again for an error that may pass, and says why a run did not start", () => {
    expect(askNotice(previewed({ kind: "error", message: "No connection.", retry: true }))).toEqual({
      kind: "error",
      text: "No connection.",
      retry: true,
    });
    const starting = askReducer(previewed({ kind: "ok", preview: FIXTURE_PREVIEW }), { type: "run" });
    const failed = askReducer(starting, { type: "runFailed", message: "Too many answers this hour." });
    expect(askNotice(failed)).toEqual({ kind: "run_failed", text: "Too many answers this hour." });
  });

  it("tells the live region what is happening", () => {
    const loading = askReducer(INITIAL_ASK_STATE, { type: "preview", question: Q });
    expect(askStatusText(loading, null)).toBe("Reading your question…");
    expect(askStatusText(loading, null, true)).toBe("Waiting for the check below the question.");
    const starting = askReducer(previewed({ kind: "ok", preview: FIXTURE_PREVIEW }), { type: "run" });
    expect(askStatusText(starting, null)).toBe("Starting your answer…");
    const notice = askNotice(previewed({ kind: "ok", preview: FIXTURE_PREVIEW_ONE_NAME }));
    expect(askStatusText(previewed({ kind: "ok", preview: FIXTURE_PREVIEW_ONE_NAME }), notice)).toBe(notice!.text);
  });

  it("prints how long until previews resume", () => {
    expect(waitText(20)).toBe("under a minute");
    expect(waitText(900)).toBe("about 15 min");
    expect(waitText(61)).toBe("about 2 min");
    expect(waitText(7200)).toBe("about 2 h");
  });
});

describe("readingGap", () => {
  const brand = (text: string, role: Mention["role"]): Mention => ({ text, entity_type: "brand", role, public_figure: false });
  const blank: Intent = {
    pillar: "investment",
    job: "brand_health",
    mentions: [],
    geo: { metro: null, area: null, unsupported_place: null, market: null, target_metro: null, cities: [] },
    constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [], concept_description: null },
    safety: { allowed: true, category: null, reframe: null },
    read_as: { nearest: false, not_covered: [] },
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
  const austin = { metro: "austin" as const, area: null, unsupported_place: null, market: null, target_metro: null, cities: [] };
  const concepts = (...c: string[]) => ({ ...blank.constraints, concepts: c });


  it("says what each job lacks, in one sentence", () => {
    const short: Array<[Partial<Intent>, string, string]> = [
      [{ job: "head_to_head" }, "Two brands to compare", "Add the two brands you want to compare."],
      [
        { job: "head_to_head", mentions: [brand("Juniper Cola", "primary")] },
        "A second brand to compare with Juniper Cola",
        "Add a second brand to compare with Juniper Cola.",
      ],
      [{ job: "brand_health" }, "A brand to read", "Add the brand you want to know about."],
      [{ job: "sponsorship" }, "An artist to find sponsors for", "Add the artist you want to find sponsors for."],
      [{ job: "market_selection" }, "A brand or artist to launch or tour", "Add the brand or artist you want to launch or tour."],
      [
        { job: "audience_discovery" },
        "A brand, artist or show whose audience to read",
        "Add the brand, artist or show whose audience you want to know.",
      ],
      [{ job: "site_selection" }, "A concept to open and one of the 13 cities we map", `Add what you want to open, and the city: ${CITIES}.`],
      [{ job: "site_selection", geo: austin }, "A concept to open", "Add what you want to open."],
      [{ job: "site_selection", constraints: concepts("ramen counter") }, "A city, one of the 13 cities we map", CITIES_TEXT],
      [{ job: "area_profile" }, "A neighbourhood and its city, one of the 13 cities we map", `Add a neighbourhood and its city: ${CITIES}.`],
      [{ job: "tenant_mix", geo: austin }, "A neighbourhood in Austin", "Add a neighbourhood in Austin."],
      [
        { job: "area_profile", geo: { ...blank.geo, area: "Riverside" } },
        "The neighbourhood's city, one of the 13 cities we map",
        `Add the neighbourhood's city: ${CITIES}.`,
      ],
      [{ job: "brand_collab" }, "A brand to find collaboration partners for", "Add the brand you want to find collaboration partners for."],
      [{ job: "creator_fit" }, "A brand whose audience the creators should fit", "Add the brand whose audience the creators should fit."],
      [{ job: "launch_test" }, "The product or concept to test", "Add the product or concept you want to test, in a few words."],
      [{ job: "city_compare", geo: { ...blank.geo, cities: ["austin"] } }, "Two to four US cities to compare", "Add the two to four US cities you want to compare."],
      [
        { job: "taste_twins", geo: { ...austin, area: "Riverside" } },
        "The city to look in, one of the 13 cities we map",
        `Add the city to look for its twin in: ${CITIES}.`,
      ],
      [
        { job: "taste_twins", geo: { ...blank.geo, target_metro: "denver" } },
        "The area to match and its city, one of the 13 cities we map",
        `Add the neighbourhood you want to match and its city: ${CITIES}.`,
      ],
      [
        { job: "taste_twins" },
        "An area, its city and a city to look in, one of the 13 cities we map",
        `Add the neighbourhood you want to match, its city and the city to look for its twin in: ${CITIES}.`,
      ],
    ];
    for (const [over, need, text] of short) {
      const reading = understood(over);
      expect(reading.mnemonic, need).toMatch(/<[A-Z]+>/);
      expect(readingGap(reading), reading.mnemonic).toEqual({ need, text });
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
      { job: "brand_collab", mentions: [brand("Juniper Cola", "primary")] },
      { job: "creator_fit", mentions: [brand("Juniper Cola", "primary")] },
      { job: "launch_test", constraints: concepts("small-batch hot sauce") },
      { job: "city_compare", geo: { ...blank.geo, cities: ["austin", "denver", "nashville"] } },
      { job: "taste_twins", geo: { ...austin, area: "Riverside", target_metro: "denver" } },
    ];
    for (const over of complete) {
      const reading = understood(over);
      expect(readingGap(reading), reading.mnemonic).toBeNull();
    }
  });

  it("needs a second brand the run can use: one that matched, named as the one to compare", () => {
    const unmatched = understood({ job: "head_to_head", mentions: [brand("Juniper Cola", "primary"), brand("Brand Betta", "peer")] }, "not_found");
    expect(unmatched.mnemonic).toBe("JUNIPER COLA VS BRAND BETTA");
    expect(readingGap(unmatched)).toEqual({
      need: "A second brand to compare with Juniper Cola",
      text: `We couldn't find "Brand Betta". Check the spelling, or name another brand to compare.`,
    });
    const secondary = understood({ job: "head_to_head", mentions: [brand("Juniper Cola", "primary"), brand("Brand Beta", "secondary")] });
    expect(readingGap(secondary)?.text).toBe(`Ask it as "Juniper Cola vs Brand Beta" to compare the two.`);
  });
});
