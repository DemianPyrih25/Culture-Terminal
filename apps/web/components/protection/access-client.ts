import { Lane, Mode } from "@ct/contracts";
import { z } from "zod";

/**
 * The browser side of GET /api/access: the visitor's lane and its mode, and the human check
 * (Turnstile's site key, and whether this browser already passed it). One read is shared by the
 * human check and the question box's paused state, and read again once it is ACCESS_TTL_MS old (a
 * breaker trips, or lifts at 00:00 UTC, without a page load), or at once after the server asks for
 * a new check or pauses live analysis. Mounted readers hear of every new read.
 */

const AccessSchema = z.object({
  lane: Lane,
  /** Null when the server could not read it. */
  mode: Mode.nullable(),
  /** The step-down's sentence ("Live analysis is paused: …"); null while live. */
  message: z.string().nullable(),
  until: z.string().nullable(),
  /** Null while the check is off (no Turnstile keys). */
  turnstile: z.object({ siteKey: z.string().min(1) }).nullable(),
  /** This browser holds a valid human-check cookie (httpOnly, so only the server can tell). */
  verified: z.boolean(),
});

export type Access = z.infer<typeof AccessSchema>;

/** The answer as Access, or null when it is not one. */
export function readAccess(body: unknown): Access | null {
  const parsed = AccessSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** GET /api/access; null when it fails or answers something else. */
export async function fetchAccess(doFetch: typeof fetch = fetch): Promise<Access | null> {
  try {
    const res = await doFetch("/api/access", { cache: "no-store", headers: { accept: "application/json" } });
    return res.ok ? readAccess(await res.json()) : null;
  } catch {
    return null;
  }
}

/** How old a read may be before loadAccess reads again. */
export const ACCESS_TTL_MS = 60_000;

/** The access store: a shared read, the last answer and who listens. Exported as a class so tests make their own. */
export class AccessStore {
  private read: { at: number; promise: Promise<Access | null> } | null = null;
  private latest: Access | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly fetchFn: () => Promise<Access | null> = () => fetchAccess(),
    private readonly now: () => number = Date.now,
  ) {}

  /** The current read, or a new one when there is none, it is ACCESS_TTL_MS old, or `fresh` asks. */
  load(fresh = false): Promise<Access | null> {
    const now = this.now();
    if (fresh || this.read === null || now - this.read.at >= ACCESS_TTL_MS) {
      const promise = this.fetchFn().then((access) => {
        // A later read may have started meanwhile: only the newest one speaks.
        if (this.read?.promise === promise) {
          this.latest = access;
          for (const listener of this.listeners) listener();
        }
        return access;
      });
      this.read = { at: now, promise };
    }
    return this.read.promise;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The last answer read; null before one, and when it could not be read. */
  readonly getSnapshot = (): Access | null => this.latest;
}

/** This tab's access. */
export const accessStore = new AccessStore();

/** This tab's access (a read shared until it is ACCESS_TTL_MS old); `fresh` reads it again now. */
export function loadAccess(fresh = false): Promise<Access | null> {
  return accessStore.load(fresh);
}
