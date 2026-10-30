import { Follow, FollowCreated, FollowList, FOLLOWS_PER_VISITOR_MAX, FollowUpdated, RunStatus, type FollowCreate } from "@ct/contracts";
import { z } from "zod";
import { isRunId } from "../../lib/run-id";
import { browserStorage, type StorageLike } from "../../lib/recent-briefs";

/**
 * The browser side of /api/follows, and the tab's shared copy of the follows that the Following page
 * and every Follow button read, so one page asks the server once. Pure but for the requests (a
 * stand-in fetch in tests). POST goes through the human check's fetch, passed in by the caller.
 */

export class FollowsError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
    /** True when trying again may help (the server or the network was down). */
    readonly retry = false,
  ) {
    super(message);
    this.name = "FollowsError";
  }
}

type Fetch = typeof fetch;
const ErrorBody = z.object({ error: z.string(), code: z.string().optional(), retry: z.boolean().optional() });

async function call<T>(doFetch: Fetch, url: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  const res = await doFetch(url, init).catch(() => null);
  if (res === null) throw new FollowsError("Could not reach the server. Check your connection and try again.", null, true);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ErrorBody.safeParse(body);
    const retry = res.status >= 500 || (err.success && err.data.retry === true);
    throw new FollowsError(err.success ? err.data.error : "Something went wrong. Try again.", err.success ? (err.data.code ?? null) : null, retry);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new FollowsError("The server sent an answer this page cannot read.", null, true);
  return parsed.data;
}

const jsonInit = (method: string, value: unknown, signal?: AbortSignal): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
  ...(signal ? { signal } : {}),
});

export function fetchFollows(doFetch: Fetch = fetch, signal?: AbortSignal): Promise<FollowList> {
  return call(doFetch, "/api/follows", { cache: "no-store", ...(signal ? { signal } : {}) }, FollowList);
}

/** POST /api/follows; pass the human check's fetch (sharedHumanFetch) so a token rides along when one is due. */
export function createFollow(body: FollowCreate, doFetch: Fetch): Promise<FollowCreated> {
  return call(doFetch, "/api/follows", jsonInit("POST", body), FollowCreated);
}

export async function deleteFollow(id: string, doFetch: Fetch = fetch): Promise<void> {
  await call(doFetch, "/api/follows", jsonInit("DELETE", { id }), z.object({ removed: z.boolean() }));
}

export async function pointFollow(id: string, runId: string, doFetch: Fetch = fetch): Promise<Follow> {
  return (await call(doFetch, "/api/follows", jsonInit("PATCH", { id, runId }), FollowUpdated)).follow;
}

// The shared copy --------------------------------------------------------------------------------

export type FollowsState =
  | { kind: "loading" }
  | { kind: "ready"; follows: Follow[]; max: number }
  | { kind: "error"; message: string; retry: boolean };

export const FOLLOWS_LOADING: FollowsState = { kind: "loading" };

export class FollowsStore {
  private state: FollowsState = FOLLOWS_LOADING;
  private loading: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly doFetch: Fetch = (...args) => fetch(...args)) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): FollowsState => this.state;

  private set(next: FollowsState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  /** Reads the follows once (again with `fresh`). */
  load(fresh = false): Promise<void> {
    if (fresh || this.loading === null) {
      if (fresh) this.set(FOLLOWS_LOADING);
      this.loading = fetchFollows(this.doFetch).then(
        (list) => this.set({ kind: "ready", follows: list.follows, max: list.max }),
        (err: unknown) =>
          this.set({
            kind: "error",
            message: "Your follows couldn't be loaded.",
            retry: err instanceof FollowsError ? err.retry : true,
          }),
      );
    }
    return this.loading;
  }

  private follows(): Follow[] {
    return this.state.kind === "ready" ? this.state.follows : [];
  }

  /** Puts a new or changed follow in place (newest first for a new one). */
  upsert(follow: Follow): void {
    const max = this.state.kind === "ready" ? this.state.max : FOLLOWS_PER_VISITOR_MAX;
    const rest = this.follows().filter((f) => f.id !== follow.id);
    const at = this.follows().findIndex((f) => f.id === follow.id);
    const follows = at < 0 ? [follow, ...rest] : this.follows().map((f) => (f.id === follow.id ? follow : f));
    this.set({ kind: "ready", follows, max });
  }

  drop(id: string): void {
    if (this.state.kind !== "ready") return;
    this.set({ ...this.state, follows: this.state.follows.filter((f) => f.id !== id) });
  }

  async follow(body: FollowCreate, humanFetch: Fetch): Promise<Follow> {
    const { follow } = await createFollow(body, humanFetch);
    this.upsert(follow);
    return follow;
  }

  async unfollow(id: string): Promise<void> {
    try {
      await deleteFollow(id, this.doFetch);
    } catch (err) {
      // Already gone (another tab unfollowed it): the row goes all the same.
      if (!(err instanceof FollowsError && err.code === "not_found")) throw err;
    }
    this.drop(id);
  }
}

let shared: FollowsStore | null = null;

/** This tab's follows, shared by the Following page and the Follow buttons. */
export function sharedFollows(): FollowsStore {
  return (shared ??= new FollowsStore());
}

// Re-runs ----------------------------------------------------------------------------------------

/**
 * Re-runs started from this browser that have not ended yet, by follow id, kept in localStorage so a
 * re-run still lands on its follow when the visitor leaves Following and comes back. A per-browser
 * convenience: a re-run that is never seen ending stays a run in Your answers.
 */
export const PENDING_RERUNS_SLOT = "ct:follow-reruns";
const Pending = z.record(z.string().min(1).max(64), z.string().refine(isRunId));

export function readPendingReruns(storage: StorageLike | null = browserStorage()): Record<string, string> {
  if (storage === null) return {};
  try {
    const parsed = Pending.safeParse(JSON.parse(storage.getItem(PENDING_RERUNS_SLOT) ?? "{}"));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writePendingRerun(followId: string, runId: string | null, storage: StorageLike | null = browserStorage()): void {
  if (storage === null) return;
  const next = { ...readPendingReruns(storage) };
  if (runId === null) delete next[followId];
  else next[followId] = runId;
  try {
    storage.setItem(PENDING_RERUNS_SLOT, JSON.stringify(next));
  } catch {
    // Full or blocked storage: the re-run is followed only while this page stays open.
  }
}

const RunSnapshot = z.object({ run: z.object({ status: RunStatus }) });

/** The run's status from GET /api/runs/[id]; null when the run is gone, undefined when it could not be read. */
export async function runStatus(runId: string, doFetch: Fetch = fetch, signal?: AbortSignal): Promise<RunStatus | null | undefined> {
  const res = await doFetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: "no-store", ...(signal ? { signal } : {}) }).catch(() => null);
  if (res === null) return undefined;
  if (res.status === 404) return null;
  if (!res.ok) return undefined;
  const parsed = RunSnapshot.safeParse(await res.json().catch(() => null));
  return parsed.success ? parsed.data.run.status : undefined;
}
