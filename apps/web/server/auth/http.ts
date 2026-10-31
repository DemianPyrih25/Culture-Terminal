import {
  createUser,
  deleteOtherSessions,
  getDb,
  getUserByEmail,
  getUserById,
  isConnectionError,
  type PublicUser,
  updateUserName,
  updateUserPassword,
} from "@ct/db";
import type { z } from "zod";
import { clientIp } from "../client-ip";
import { log } from "../log";
import { dummyPasswordHash, hashPassword, verifyPassword } from "./password";
import { authLimiters } from "./rate-limit";
import {
  clearedSessionCookie,
  endSession,
  sessionCookie,
  sessionIdFor,
  startSession,
  tokenFromRequest,
  userForToken,
} from "./session";
import { ChangePasswordInput, fieldErrors, LoginInput, SignupInput, UpdateProfileInput } from "./validate";

// The auth route handlers' bodies. Route files under app/api/auth stay thin and call these.

const NO_STORE = { "Cache-Control": "no-store" };
const BAD_LOGIN = "Wrong email or password.";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

function userJson(user: PublicUser) {
  return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt.toISOString() };
}

function failure(err: unknown, what: string): Response {
  if (isConnectionError(err)) {
    log.warn({ err }, `${what}: database unavailable`);
    return json({ error: "We can't reach your account right now. Please try again in a moment." }, 503, { "Retry-After": "5" });
  }
  log.error({ err }, `${what} failed`);
  return json({ error: "Something went wrong. Please try again." }, 500);
}

async function readBody<T extends z.ZodType>(request: Request, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, res: json({ error: "Send the form as JSON." }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = fieldErrors(parsed.error);
    return { ok: false, res: json({ error: Object.values(fields)[0] ?? "Check the form.", fields }, 400) };
  }
  return { ok: true, data: parsed.data };
}

function limited(retryAfterS: number): Response {
  const minutes = Math.max(1, Math.ceil(retryAfterS / 60));
  return json(
    { error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` },
    429,
    { "Retry-After": String(retryAfterS) },
  );
}

/** Rejects cross-site form posts: a browser always sends Origin on a cross-origin POST. */
function crossSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Per-address key, or null without a real client address (local dev on loopback, tests), where no
 * per-address limit applies, as elsewhere in the app. The per-email login limit still applies.
 */
function ipKey(request: Request): string | null {
  const ip = clientIp(request);
  return ip === null || LOOPBACK.has(ip) ? null : `ip:${ip}`;
}

/** Records an attempt under each key; returns the longest wait (0 when allowed). */
function hitAll(limiter: { hit(key: string): number }, keys: (string | null)[]): number {
  let wait = 0;
  for (const key of keys) if (key !== null) wait = Math.max(wait, limiter.hit(key));
  return wait;
}

export async function signupResponse(request: Request): Promise<Response> {
  if (crossSite(request)) return json({ error: "Forbidden." }, 403);
  const body = await readBody(request, SignupInput);
  if (!body.ok) return body.res;
  const wait = hitAll(authLimiters().signup, [ipKey(request)]);
  if (wait > 0) return limited(wait);
  try {
    const created = await createUser(getDb(), {
      name: body.data.name,
      email: body.data.email,
      passwordHash: await hashPassword(body.data.password),
    });
    if (!created.ok) {
      return json({ error: "An account with this email already exists. Sign in instead.", fields: { email: "An account with this email already exists." } }, 409);
    }
    const token = await startSession(created.user.id);
    return json({ user: userJson(created.user) }, 201, { "Set-Cookie": sessionCookie(token) });
  } catch (err) {
    return failure(err, "signup");
  }
}

export async function loginResponse(request: Request): Promise<Response> {
  if (crossSite(request)) return json({ error: "Forbidden." }, 403);
  const body = await readBody(request, LoginInput);
  if (!body.ok) return body.res;
  const wait = hitAll(authLimiters().login, [ipKey(request), `email:${body.data.email}`]);
  if (wait > 0) return limited(wait);
  try {
    const user = await getUserByEmail(getDb(), body.data.email);
    // Verify against a dummy hash when the email is unknown, so timing does not reveal which emails exist.
    const ok = await verifyPassword(body.data.password, user?.passwordHash ?? (await dummyPasswordHash()));
    if (!user || !ok) return json({ error: BAD_LOGIN }, 401);
    const token = await startSession(user.id);
    return json({ user: userJson(user) }, 200, { "Set-Cookie": sessionCookie(token) });
  } catch (err) {
    return failure(err, "login");
  }
}

export async function logoutResponse(request: Request): Promise<Response> {
  if (crossSite(request)) return json({ error: "Forbidden." }, 403);
  try {
    await endSession(tokenFromRequest(request));
  } catch (err) {
    log.warn({ err }, "logout: session not removed");
  }
  return json({ ok: true }, 200, { "Set-Cookie": clearedSessionCookie() });
}

export async function meResponse(request: Request): Promise<Response> {
  try {
    const user = await userForToken(tokenFromRequest(request));
    if (!user) return json({ user: null }, 401);
    return json({ user: userJson(user) });
  } catch (err) {
    return failure(err, "me");
  }
}

/** PATCH /api/auth/me: changes the display name. */
export async function updateMeResponse(request: Request): Promise<Response> {
  if (crossSite(request)) return json({ error: "Forbidden." }, 403);
  try {
    const user = await userForToken(tokenFromRequest(request));
    if (!user) return json({ error: "Sign in again." }, 401);
    const body = await readBody(request, UpdateProfileInput);
    if (!body.ok) return body.res;
    const updated = await updateUserName(getDb(), user.id, body.data.name);
    return updated ? json({ user: userJson(updated) }) : json({ error: "Sign in again." }, 401);
  } catch (err) {
    return failure(err, "update profile");
  }
}

/** POST /api/auth/password: changes the password and signs out every other session. */
export async function changePasswordResponse(request: Request): Promise<Response> {
  if (crossSite(request)) return json({ error: "Forbidden." }, 403);
  try {
    const token = tokenFromRequest(request);
    const user = await userForToken(token);
    if (!user || !token) return json({ error: "Sign in again." }, 401);
    const body = await readBody(request, ChangePasswordInput);
    if (!body.ok) return body.res;
    const wait = authLimiters().login.hit(`user:${user.id}`);
    if (wait > 0) return limited(wait);
    const row = await getUserById(getDb(), user.id);
    if (!row || !(await verifyPassword(body.data.currentPassword, row.passwordHash))) {
      return json({ error: "Your current password is not right.", fields: { currentPassword: "Your current password is not right." } }, 400);
    }
    await updateUserPassword(getDb(), user.id, await hashPassword(body.data.newPassword));
    await deleteOtherSessions(getDb(), user.id, sessionIdFor(token));
    return json({ ok: true });
  } catch (err) {
    return failure(err, "change password");
  }
}
