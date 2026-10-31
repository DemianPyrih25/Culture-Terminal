import "server-only";
import type { PublicUser } from "@ct/db";
import { cookies } from "next/headers";
import { log } from "../log";
import { SESSION_COOKIE, userForToken } from "./session";

/** The signed-in user for the page being rendered, or null. A database outage reads as signed out. */
export async function currentUser(): Promise<PublicUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    return await userForToken(token);
  } catch (err) {
    log.warn({ err }, "currentUser: session lookup failed");
    return null;
  }
}
