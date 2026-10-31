import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { Queryable } from "../client";
import { type SessionRow, sessions, type UserRow, users } from "../schema";

/**
 * Accounts and sessions. Emails are compared lowercased and trimmed; callers hash passwords and session
 * tokens before they reach this module, so no secret is ever written here in the clear.
 */

/** What the app may show about a user: never the password hash. */
export type PublicUser = Pick<UserRow, "id" | "email" | "name" | "createdAt">;

export interface NewUser {
  email: string;
  name: string;
  passwordHash: string;
}

export type CreateUserResult = { ok: true; user: PublicUser } | { ok: false; reason: "email_taken" };

const publicColumns = { id: users.id, email: users.email, name: users.name, createdAt: users.createdAt };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Creates an account; a second account with the same email is refused. */
export async function createUser(db: Queryable, input: NewUser): Promise<CreateUserResult> {
  const rows = await db
    .insert(users)
    .values({ email: normalizeEmail(input.email), name: input.name, passwordHash: input.passwordHash })
    .onConflictDoNothing({ target: users.email })
    .returning(publicColumns);
  const user = rows[0];
  return user ? { ok: true, user } : { ok: false, reason: "email_taken" };
}

/** The full row (with the hash) for a sign-in check, or undefined. */
export async function getUserByEmail(db: Queryable, email: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1);
  return row;
}

/** The full row (with the hash) by id, or undefined. */
export async function getUserById(db: Queryable, id: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

export async function updateUserName(db: Queryable, id: string, name: string): Promise<PublicUser | undefined> {
  const [row] = await db.update(users).set({ name }).where(eq(users.id, id)).returning(publicColumns);
  return row;
}

export async function updateUserPassword(db: Queryable, id: string, passwordHash: string): Promise<boolean> {
  const rows = await db.update(users).set({ passwordHash }).where(eq(users.id, id)).returning({ id: users.id });
  return rows.length > 0;
}

/** Stores a session. id is the SHA-256 of the cookie token. */
export async function createSession(db: Queryable, input: { id: string; userId: string; expiresAt: Date }): Promise<SessionRow> {
  const [row] = await db.insert(sessions).values(input).returning();
  return row as SessionRow;
}

/** The unexpired session's user, or undefined. */
export async function getSessionUser(db: Queryable, sessionId: string): Promise<PublicUser | undefined> {
  const [row] = await db
    .select(publicColumns)
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, sql`now()`)))
    .limit(1);
  return row;
}

export async function deleteSession(db: Queryable, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Signs the user out everywhere except the given session (after a password change). */
export async function deleteOtherSessions(db: Queryable, userId: string, keepSessionId: string | null): Promise<void> {
  await db
    .delete(sessions)
    .where(keepSessionId === null ? eq(sessions.userId, userId) : and(eq(sessions.userId, userId), sql`${sessions.id} <> ${keepSessionId}`));
}

/** Removes expired sessions; returns how many. */
export async function deleteExpiredSessions(db: Queryable): Promise<number> {
  const rows = await db.delete(sessions).where(lte(sessions.expiresAt, sql`now()`)).returning({ id: sessions.id });
  return rows.length;
}
