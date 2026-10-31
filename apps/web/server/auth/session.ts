import { createHash, randomBytes } from "node:crypto";
import { createSession, deleteSession, getDb, getSessionUser, type PublicUser } from "@ct/db";

// Sessions: the browser holds a random 32-byte token in an httpOnly cookie; the database holds only its
// SHA-256, so a leaked sessions table cannot be replayed as cookies.

export const SESSION_COOKIE = "ct_session";
export const SESSION_TTL_S = 30 * 24 * 3600;

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionIdFor(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A token only from our own generator (43 base64url chars); anything else is never looked up. */
export function isWellFormedToken(token: string | undefined | null): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

function secureCookies(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production";
}

export function sessionCookie(token: string, env: NodeJS.ProcessEnv = process.env): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${SESSION_TTL_S}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secureCookies(env) ? ["Secure"] : []),
  ].join("; ");
}

export function clearedSessionCookie(env: NodeJS.ProcessEnv = process.env): string {
  return [`${SESSION_COOKIE}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax", ...(secureCookies(env) ? ["Secure"] : [])].join("; ");
}

/** Starts a session for the user; returns the cookie token (stored only as its hash). */
export async function startSession(userId: string): Promise<string> {
  const token = newSessionToken();
  await createSession(getDb(), { id: sessionIdFor(token), userId, expiresAt: new Date(Date.now() + SESSION_TTL_S * 1000) });
  return token;
}

/** The signed-in user for a cookie token, or null (missing, malformed, unknown or expired). */
export async function userForToken(token: string | undefined | null): Promise<PublicUser | null> {
  if (!isWellFormedToken(token)) return null;
  return (await getSessionUser(getDb(), sessionIdFor(token))) ?? null;
}

export async function endSession(token: string | undefined | null): Promise<void> {
  if (!isWellFormedToken(token)) return;
  await deleteSession(getDb(), sessionIdFor(token));
}

/** The session cookie's value from a request's Cookie header. */
export function tokenFromRequest(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Whether pages are gated behind sign-in. AUTH_REQUIRED=0 turns the gate off (mock e2e smoke). */
export function authRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTH_REQUIRED?.trim() !== "0";
}
