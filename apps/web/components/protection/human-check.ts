import type { Access } from "./access-client";

/**
 * The browser's half of the human check (SPEC §10.3), kept apart from React so it is tested without
 * a browser. The Turnstile widget hands out single-use tokens; a request that spends (a live run, a
 * preview) takes one, and the server answers with a two-hour httpOnly cookie, after which no token
 * is needed until the server asks again (403 `{turnstile: true}`).
 *
 *   loading ─access→ off (no Turnstile) | verified (cookie) | checking
 *   checking ─widget asks the visitor→ interactive ─solved→ checking
 *   checking | interactive ─widget fails→ error ─retry→ checking
 *   checking ─the server says a request passed→ verified ─server asks again→ checking
 *
 * A widget that never loaded (Cloudflare's script blocked, or a browser Turnstile does not support)
 * is an error at once, never a silent wait: a reset cannot bring its token.
 */

export type HumanStatus = "loading" | "off" | "verified" | "checking" | "interactive" | "error";

export interface HumanState {
  status: HumanStatus;
  /** The widget's site key; null until access is read, and while the check is off. */
  siteKey: string | null;
  /** The widget's error code, while status is error (SCRIPT_ERROR and UNSUPPORTED_ERROR are ours). */
  error: string | null;
}

/** How long a request waits for the widget's token before it goes without one (the server then asks again). */
export const TOKEN_WAIT_MS = 30_000;

/** The error of a widget whose script did not load (a blocker, a firewall, an outage). */
export const SCRIPT_ERROR = "script";
/** The error of a browser Turnstile does not support. */
export const UNSUPPORTED_ERROR = "unsupported";

/** Whether the error is a widget that never loaded: only mounting it afresh (or another browser) can help. */
export function isLoadFailure(error: string | null): boolean {
  return error === SCRIPT_ERROR || error === UNSUPPORTED_ERROR;
}

/**
 * Set to "passed" on an answer whose request passed the human check: the only sign the browser now
 * holds the cookie. server/access.ts HUMAN_CHECK_HEADER is the same name.
 */
export const HUMAN_CHECK_HEADER = "x-human-check";

/** Before access is read, and always on the server (the page renders without the widget). */
export const HUMAN_LOADING: HumanState = { status: "loading", siteKey: null, error: null };

export class HumanCheck {
  private state: HumanState = HUMAN_LOADING;
  private readonly listeners = new Set<() => void>();
  /** A token the widget handed out that no request has taken yet. */
  private token: string | null = null;
  /** The widget's last token went to a request: the next one needs a reset to come. */
  private spent = false;
  private waiters: ((token: string | null) => void)[] = [];
  private resetWidget: (() => void) | null = null;
  private loading: Promise<void> | null = null;

  /** @param read reads GET /api/access (`fresh` reads it again); injected in tests. */
  constructor(private readonly read: (fresh: boolean) => Promise<Access | null>) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): HumanState => this.state;

  private set(next: Partial<HumanState>): void {
    const merged = { ...this.state, ...next };
    if (merged.status === this.state.status && merged.siteKey === this.state.siteKey && merged.error === this.state.error) return;
    this.state = merged;
    for (const listener of this.listeners) listener();
  }

  /** Reads the access once (again with `fresh`). */
  load(fresh = false): Promise<void> {
    if (fresh || this.loading === null) {
      this.loading = this.read(fresh).then(
        (access) => this.configure(access),
        () => this.configure(null),
      );
    }
    return this.loading;
  }

  /** Sets the status from what the server said; access it could not read leaves the check off. */
  configure(access: Access | null): void {
    const siteKey = access?.turnstile?.siteKey ?? null;
    if (siteKey === null) this.set({ status: "off", siteKey: null, error: null });
    else this.set({ status: access?.verified ? "verified" : "checking", siteKey, error: null });
    if (this.state.status === "off" || this.state.status === "verified") this.release(null);
  }

  /** The widget mounted: `reset` asks it for a new token. Returns the detach. */
  attach(reset: () => void): () => void {
    this.resetWidget = reset;
    return () => {
      if (this.resetWidget === reset) this.resetWidget = null;
    };
  }

  /**
   * A token for the next request that spends, or null when none is needed (the check is off, or the
   * cookie is valid), none can come (the widget failed) or none came within `waitMs`. While
   * Cloudflare waits for the visitor's click the wait does not run out: the click's token, or the
   * widget's error, ends it. A token is handed out once.
   */
  async take(waitMs: number = TOKEN_WAIT_MS): Promise<string | null> {
    await this.load();
    const { status } = this.state;
    if (status === "off" || status === "verified" || status === "error") return null;
    if (this.token !== null) {
      const token = this.token;
      this.token = null;
      this.spent = true;
      return token;
    }
    if (this.spent && this.waiters.length === 0) {
      // The widget gives one token per run: ask it for the next.
      this.spent = false;
      this.resetWidget?.();
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (token: string | null) => {
        clearTimeout(timer);
        resolve(token);
      };
      const arm = () => {
        timer = setTimeout(() => {
          // The visitor is solving the challenge: going without a token now would reset it under them.
          if (this.state.status === "interactive") {
            arm();
            return;
          }
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(null);
        }, waitMs);
      };
      this.waiters.push(waiter);
      arm();
    });
  }

  private release(token: string | null): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(token);
  }

  /** A token taken for a request that was never sent (it was cancelled first): the next request uses it. */
  restore(token: string): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(token);
    } else if (this.token === null) {
      this.token = token;
      this.spent = false;
    }
  }

  /** The server says a request passed the check (HUMAN_CHECK_HEADER): it holds this browser verified now. */
  passed(): void {
    if (this.state.siteKey !== null && this.state.status !== "off") this.set({ status: "verified", error: null });
    this.token = null;
  }

  /** The server asked for a check (the cookie lapsed, or the token failed): get a new token. */
  required(): void {
    this.token = null;
    this.spent = false;
    if (this.state.siteKey === null) {
      // The page never learnt the site key (access could not be read): ask for it again.
      void this.load(true);
      return;
    }
    // A widget that never loaded cannot be reset into a token: the error, and its card, stand.
    if (this.state.status === "error" && isLoadFailure(this.state.error)) return;
    // The visitor is solving the challenge: its token is the next one, and a reset would throw it away.
    if (this.state.status === "interactive") return;
    this.set({ status: "checking", error: null });
    this.resetWidget?.();
  }

  // The widget's callbacks ----------------------------------------------------------------------

  readonly onToken = (token: string): void => {
    if (this.state.status === "interactive" || this.state.status === "error") this.set({ status: "checking", error: null });
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(token);
      // Single use: the next waiter, if any, needs a token of its own.
      this.spent = this.waiters.length === 0;
      if (this.waiters.length > 0) this.resetWidget?.();
    } else {
      this.token = token;
      this.spent = false;
    }
  };

  readonly onExpire = (): void => {
    this.token = null;
  };

  readonly onInteractive = (): void => {
    this.set({ status: "interactive" });
  };

  readonly onError = (code: string): void => {
    this.token = null;
    this.set({ status: "error", error: code });
    this.release(null);
  };

  /** Cloudflare's script did not load: the widget never will, so requests stop waiting for it. */
  readonly onScriptError = (): void => this.onError(SCRIPT_ERROR);

  /** Turnstile cannot run in this browser. */
  readonly onUnsupported = (): void => this.onError(UNSUPPORTED_ERROR);

  /**
   * Try again after an error. A widget that never loaded is mounted afresh by the panel, which runs
   * the challenge by itself; any other is reset.
   */
  readonly retry = (): void => {
    const remount = isLoadFailure(this.state.error);
    this.spent = false;
    this.set({ status: "checking", error: null });
    if (!remount) this.resetWidget?.();
  };
}

/** Body of a 403 that asks for a new check. */
function asksForCheck(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { turnstile?: unknown }).turnstile === true;
}

/** The init with the token added to its JSON body; any other body is left as it is. */
function withToken(init: RequestInit | undefined, token: string | null): RequestInit | undefined {
  if (token === null || typeof init?.body !== "string") return init;
  let value: unknown;
  try {
    value = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return init;
  return { ...init, body: JSON.stringify({ ...value, turnstileToken: token }) };
}

/** Whether the server says the request passed the check (not an answer that came before it, such as the answer cache's). */
const passedCheck = (res: Response): boolean => res.headers.get(HUMAN_CHECK_HEADER) === "passed";

/**
 * A fetch for requests that spend: it adds the check's token to the JSON body when one is needed,
 * and when the server answers 403 `{turnstile: true}` it gets a new token and sends the request once
 * more. The browser holds itself verified only when the server says the check passed. Pass it as
 * lib/start-run's `fetch`, or call it like fetch.
 */
export function humanFetch(check: HumanCheck, base: typeof fetch = (...args) => fetch(...args)): typeof fetch {
  return async (input, init) => {
    const first = await check.take();
    // Cancelled while it waited for the token: the token was never sent, so the next request takes it.
    if (first !== null && init?.signal?.aborted) check.restore(first);
    const res = await base(input, withToken(init, first));
    if (res.status !== 403) {
      if (passedCheck(res)) check.passed();
      return res;
    }
    const body: unknown = await res
      .clone()
      .json()
      .catch(() => null);
    if (!asksForCheck(body)) return res;
    check.required();
    const second = await check.take();
    if (second === null) return res;
    const again = await base(input, withToken(init, second));
    if (passedCheck(again)) check.passed();
    return again;
  };
}
