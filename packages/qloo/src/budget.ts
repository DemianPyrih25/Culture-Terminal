import type { Lane, Mode, Phase, RunLimits } from "@ct/contracts";
import { BudgetError } from "./errors";
import type { Now } from "./limiter";
import type { QlooLogger } from "./logger";
import { type QuotaTracker, utcDay } from "./quota";
import type { QlooEnv, QlooStore } from "./store";

/**
 * Budget gates (D24, SPEC §5.1 step 5), checked in order before every network call; cache hits never
 * reach them. Checks and reservations run one at a time, so concurrent calls cannot both take the
 * last unit of a cap. The per-tag and daily caps count rows in the store (so they hold across
 * processes) plus this process's reservations not yet written. The writes those counts read are
 * serialised with the checks, so a count never sees a write half done: it is exact, not approximate.
 * A write that fails stays counted, so a broken store can never lift a cap.
 *
 * The per-tag cap guards the live quota, so mock mode skips it. The prod daily cap holds per lane
 * (60/40) and in total: standalone calls draw on the total only, and a lane run must fit both.
 */

export const DEV_MONTH_FLOOR = 38_000;
export const PROD_MONTH_FLOOR = 2_000;
export const DEFAULT_DAILY_FRESH_CAP = 1_900;
export const DEFAULT_TAG_CAP = 200;
/** Share of the daily fresh-call cap each lane may use (D24: 40% reserved for judges). */
export const LANE_SHARE: Readonly<Record<Lane, number>> = { public: 0.6, judge: 0.4 };

export const monthFloorFor = (env: QlooEnv): number => (env === "prod" ? PROD_MONTH_FLOOR : DEV_MONTH_FLOOR);

/** The run (or standalone scope) a network call is charged to. */
export interface BudgetScope {
  readonly runId: string | null;
  /** Null for standalone tools: no run or follow-up cap. */
  readonly limits: RunLimits | null;
  readonly lane: Lane | null;
  readonly phase: () => Phase;
  readonly onWarn?: (warning: QlooBudgetWarning) => void;
  network: number;
  followup: number;
  warned: boolean;
}

/** Sent once per run when its network calls reach RunLimits.qlooWarnAt. */
export interface QlooBudgetWarning {
  runId: string | null;
  used: number;
  warnAt: number;
  cap: number;
}

export interface Reservation {
  /** The call reached the transport: it counts. */
  commit(): void;
  /** No attempt was made (e.g. the run was cancelled while queued): the budget is given back. */
  release(): void;
}

export interface BudgetGatesOptions {
  env: QlooEnv;
  tag: string;
  tagCap: number | null;
  dailyFreshCap: number;
  monthFloor: number;
  store: QlooStore;
  quota: QuotaTracker;
  now: Now;
  logger: QlooLogger;
  onModeChange: (mode: Mode) => void;
  track: (write: Promise<unknown>) => void;
}

function bump(counts: Map<string, number>, key: string, delta: number): void {
  const next = (counts.get(key) ?? 0) + delta;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class BudgetGates {
  private readonly mutex = new Mutex();
  /** The per-tag cap protects the live quota; synthetic mock calls cost nothing, so it never applies to them. */
  private readonly tagCap: number | null;
  /** Network calls reserved whose call-log row is not written yet (per-tag cap). */
  private unlogged = 0;
  /** Call-log rows that failed to write. */
  private lostLogRows = 0;
  /** Fresh calls reserved whose usage_daily increment is not written yet, by `day|lane`. */
  private readonly unstoredFresh = new Map<string, number>();
  /** usage_daily increments that failed to write, by `day|lane`. */
  private readonly lostFresh = new Map<string, number>();
  private floorSignalled = false;

  constructor(private readonly options: BudgetGatesOptions) {
    this.tagCap = options.env === "mock" ? null : options.tagCap;
  }

  /** Runs the gates in order and reserves one network call, or throws BudgetError naming the gate. */
  reserve(scope: BudgetScope): Promise<Reservation> {
    return this.mutex.run(() => this.check(scope));
  }

  /**
   * Writes the call-log row of a network call. While the tag cap counts rows, the write takes its
   * turn with the gate checks. Rejects when the write fails (the row then stays counted).
   */
  logNetworkCall(write: () => Promise<void>): Promise<void> {
    const run = async () => {
      try {
        await write();
      } catch (err) {
        this.lostLogRows += 1;
        throw err;
      } finally {
        this.unlogged = Math.max(0, this.unlogged - 1);
      }
    };
    return this.tagCap === null ? run() : this.mutex.run(run);
  }

  private async check(scope: BudgetScope): Promise<Reservation> {
    const { env, tag, store, quota, logger } = this.options;
    const tagCap = this.tagCap;
    await quota.load();
    const limits = scope.limits;
    const followup = limits !== null && scope.phase() === "followup";
    if (limits !== null) {
      if (scope.network >= limits.qlooCalls) {
        throw this.refuse("run_cap", `the run has used its ${limits.qlooCalls} Qloo network calls`);
      }
      if (followup && scope.followup >= limits.followupCalls) {
        throw this.refuse("followup_cap", `follow-ups have used their ${limits.followupCalls} Qloo network calls`);
      }
    }
    if (tagCap !== null) {
      const logged = await store.countNetworkCalls({ env, tag }).catch((err: unknown) => {
        logger.error({ err: String(err), tag }, "qloo tag cap: call count unavailable");
        throw this.refuse("tag_cap", `the network call count for QLOO_TAG "${tag}" could not be read`);
      });
      // Read after the count: a reservation released meanwhile will never write a row.
      if (logged + this.unlogged + this.lostLogRows >= tagCap) {
        throw this.refuse("tag_cap", `QLOO_TAG "${tag}" has used its ${tagCap} network calls`);
      }
    }
    const day = utcDay(this.options.now());
    if (env === "prod") {
      // A lane run must fit its own share and the day's total, which standalone calls also draw on.
      const caps: [string, number][] = [["all", this.options.dailyFreshCap]];
      if (scope.lane !== null) caps.unshift([scope.lane, Math.floor(this.options.dailyFreshCap * LANE_SHARE[scope.lane])]);
      for (const [lane, cap] of caps) {
        const used = await store.freshCalls({ day, lane }).catch((err: unknown) => {
          logger.error({ err: String(err), lane }, "qloo daily cap: counter unavailable");
          throw this.refuse("daily_lane_cap", `today's fresh-call count for lane "${lane}" could not be read`);
        });
        const key = `${day}|${lane}`;
        const pending = (this.unstoredFresh.get(key) ?? 0) + (this.lostFresh.get(key) ?? 0);
        if (used + pending >= cap) {
          throw this.refuse(
            "daily_lane_cap",
            lane === "all" ? `all ${cap} fresh Qloo calls for today are used` : `lane "${lane}" has used its ${cap} fresh Qloo calls today`,
          );
        }
      }
    }
    const remaining = quota.snapshot().monthRemaining;
    if (remaining !== null && remaining < this.options.monthFloor) {
      if (env === "prod" && !this.floorSignalled) {
        this.floorSignalled = true;
        this.options.onModeChange("replay_only");
      }
      throw this.refuse("month_floor", `${remaining} monthly Qloo calls remain, below the ${this.options.monthFloor} floor`);
    }
    if (remaining !== null) this.floorSignalled = false;

    scope.network += 1;
    if (followup) scope.followup += 1;
    this.unlogged += 1;
    const lanes = scope.lane === null ? ["all"] : [scope.lane, "all"];
    const keys = lanes.map((lane) => `${day}|${lane}`);
    for (const key of keys) bump(this.unstoredFresh, key, 1);
    this.warnIfDue(scope);

    let settled = false;
    return {
      commit: () => {
        if (settled) return;
        settled = true;
        quota.recordNetwork();
        // Mock calls cost nothing, so they stay out of the shared daily counters.
        if (env === "mock") {
          for (const key of keys) bump(this.unstoredFresh, key, -1);
          return;
        }
        const write = async () => {
          try {
            await store.addFreshCalls({ day, lanes, count: 1 });
          } catch (err) {
            for (const key of keys) bump(this.lostFresh, key, 1);
            logger.error({ err: String(err) }, "qloo daily counter could not be updated");
          } finally {
            for (const key of keys) bump(this.unstoredFresh, key, -1);
          }
        };
        // The daily gate reads these counters in prod, so there the write takes its turn with the checks.
        this.options.track(env === "prod" ? this.mutex.run(write) : write());
      },
      release: () => {
        if (settled) return;
        settled = true;
        scope.network -= 1;
        if (followup) scope.followup -= 1;
        this.unlogged = Math.max(0, this.unlogged - 1);
        for (const key of keys) bump(this.unstoredFresh, key, -1);
      },
    };
  }

  private warnIfDue(scope: BudgetScope): void {
    const limits = scope.limits;
    if (limits === null || scope.warned || scope.network < limits.qlooWarnAt) return;
    scope.warned = true;
    const warning: QlooBudgetWarning = { runId: scope.runId, used: scope.network, warnAt: limits.qlooWarnAt, cap: limits.qlooCalls };
    this.options.logger.warn(warning, "qloo run budget reached its warning level");
    try {
      scope.onWarn?.(warning);
    } catch (err) {
      this.options.logger.warn({ err: String(err) }, "qloo onWarn callback threw");
    }
  }

  private refuse(gate: BudgetError["gate"], message: string): BudgetError {
    this.options.logger.warn({ gate, tag: this.options.tag }, `qloo budget gate refused a network call: ${message}`);
    return new BudgetError(gate, message);
  }
}
