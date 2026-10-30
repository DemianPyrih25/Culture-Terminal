import "server-only";
import { ScreenerRequest, type ScreenerAnswer } from "@ct/contracts";
import { z } from "zod";
import { getAccessService, HUMAN_CHECK_HEADER, type HumanCheck } from "../access";
import { log } from "../log";
import { TURNSTILE_TOKEN_MAX } from "../turnstile";
import { unknownMarkets } from "./markets";
import type { ScreenerService } from "./service";
import { getScreenerService } from "./wiring";

/**
 * POST /api/screener. JSON ScreenerRequest plus `turnstileToken`. A screen in the answer cache answers
 * at once (200, no check, no Qloo call), like a run the answer cache holds; otherwise the human check
 * (a valid ct_human cookie or a Turnstile token, §10.3) runs before any Qloo request. 200 with a
 * ScreenerAnswer (ok, pick, not_found, or unavailable with Retry-After when the wait is known).
 * 400 on a bad body or a market config/metros.json does not list, 403 from another site or
 * without the check, 413 past the size limit, 415 unless JSON.
 */

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 8 * 1024;

const Body = ScreenerRequest.extend({ turnstileToken: z.string().min(1).max(TURNSTILE_TOKEN_MAX).nullish() }).strict();

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
const bad = (error: string, status = 400) => json({ error }, status);

/** Every answer is 200: the page words each kind; an unavailable one says when to try again in Retry-After too. */
function answerResponse(answer: ScreenerAnswer): Response {
  const retry = answer.kind === "unavailable" && answer.retryAfterS !== null ? { "Retry-After": String(answer.retryAfterS) } : undefined;
  return json(answer, 200, retry);
}

function humanRefusal(kind: Extract<HumanCheck, { ok: false }>["kind"]): Response {
  if (kind === "unavailable") return json({ error: "The check that you are a person could not be completed. Try again shortly.", retry: true }, 503, { "Retry-After": "5" });
  if (kind === "unconfigured") return json({ error: "The screener is unavailable: the human check is not configured.", retry: false }, 503);
  const error = kind === "missing" ? "Confirm you are a person to run a live screen. Screens already run need no check." : "The check that you are a person did not pass. Try again.";
  return json({ error, turnstile: true, retry: false }, 403);
}

async function readBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (request.headers.get("sec-fetch-site") === "cross-site") return { ok: false, response: bad("Screens can only be run from this site.", 403) };
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return { ok: false, response: bad("The request body is too large.", 413) };
  if (!/^application\/json\s*(;|$)/i.test((request.headers.get("content-type") ?? "").trim())) {
    return { ok: false, response: bad("Send the request body as application/json.", 415) };
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, response: bad("The request body is too large.", 413) };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: bad("The request body is not valid JSON.") };
  }
}

export async function postScreener(request: Request, service: ScreenerService = getScreenerService()): Promise<Response> {
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const parsed = Body.safeParse(read.value);
  if (!parsed.success) {
    return json({ error: "Invalid screen request.", issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) }, 400);
  }
  const { turnstileToken, ...body } = parsed.data;
  const unknown = unknownMarkets(body.markets);
  if (unknown.length > 0) return bad(`Unknown market: ${unknown.join(", ")}.`);
  try {
    const hit = service.cached(body);
    if (hit !== null) return json(hit);
    const access = getAccessService();
    const human = await access.checkHuman(request, turnstileToken);
    if (!human.ok) return humanRefusal(human.kind);
    const response = answerResponse(await service.screen({ body, lane: access.laneOf(request), visitor: access.clientKey(request) }));
    if (human.setCookie !== null) response.headers.append("Set-Cookie", human.setCookie);
    if (human.via !== "off") response.headers.set(HUMAN_CHECK_HEADER, "passed");
    return response;
  } catch (err) {
    log.error({ err }, "screener: the request failed");
    return json({ error: "Something went wrong." }, 500);
  }
}
