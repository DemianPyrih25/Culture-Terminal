import type { Lane, Mode, Phase, RunLimits, SkillId } from "@ct/contracts";
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

/**
 * Development stops at 32,000 calls left this month (D24, PLAN §11): the judging reserve of 30,000 (15
 * judging days at the 2,000-call minimum daily cap) plus the prod floor of 2,000.
 */
export const DEV_MONTH_FLOOR = 32_000;
export const PROD_MONTH_FLOOR = 2_000;
/** The static prod daily cap: outside the judging window, or before any remaining figure exists. */
export const DEFAULT_DAILY_FRESH_CAP = 1_900;
/** The dynamic daily cap never goes below this during judging (D24). */
export const JUDGING_DAILY_CAP_MIN = 2_000;
/** The last judging day (UTC), JUDGING_END_DATE's default. */
export const DEFAULT_JUDGING_END_DATE = "2026-11-16";
export const DEFAULT_TAG_CAP = 200;
/** Share of the daily fresh-call cap each lane may use (D24: 40% reserved for judges). */
export const LANE_SHARE: Readonly<Record<Lane, number>> = { public: 0.6, judge: 0.4 };

export const monthFloorFor = (env: QlooEnv): number => (env === "prod" ? PROD_MONTH_FLOOR : DEV_MONTH_FLOOR);

const DAY_MS = 86_400_000;

/** Whole UTC days from `day` to `endDay` inclusive (both YYYY-MM-DD); 0 once `day` is past `endDay`. */
export function judgingDaysLeft(day: string, endDay: string): number {
  const from = Date.parse(`${day}T00:00:00.000Z`);
  const to = Date.parse(`${endDay}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return 0;
  return Math.round((to - from) / DAY_MS) + 1;
}

export interface DailyCapInputs {
  /** QLOO_DAILY_FRESH_CAP (or DEFAULT_DAILY_FRESH_CAP): the cap outside the judging window. */
  staticCap: number;
  /** The month's remaining calls from the last response; null before one was seen. */
  monthRemaining: number | null;
  /** The UTC day the cap is for (YYYY-MM-DD). */
  day: string;
  /** JUDGING_END_DATE (YYYY-MM-DD), or null for no judging window. */
  judgingEndDate: string | null;
  /** The prod floor (PROD_MONTH_FLOOR). */
  floor: number;
}

/**
 * Today's prod fresh-call cap (D24): during judging, the month's calls above the floor spread over the
 * judging days left, at least JUDGING_DAILY_CAP_MIN and never more than the calls above the floor:
 * min(remaining - floor, max(2000, floor((remaining - floor) / daysLeft))). Outside the window (past
 * JUDGING_END_DATE, none set, or no remaining figure yet) the static cap. Never below 0.
 */
export function dailyFreshCapFor(inputs: DailyCapInputs): number {
  const { staticCap, monthRemaining, day, judgingEndDate, floor } = inputs;
  if (judgingEndDate === null || monthRemaining === null) return staticCap;
  const daysLeft = judgingDaysLeft(day, judgingEndDate);
  if (daysLeft <= 0) return staticCap;
  const above = Math.max(0, monthRemaining - floor);
  return Math.max(0, Math.min(above, Math.max(JUDGING_DAILY_CAP_MIN, Math.floor(above / daysLeft))));
}

/**
 * The follow-up calls a run holds back for one kind of tool (D24: 3 for the concept test while the
 * question has a concept part with no exact tag, PLAN §4.2). While `active()`, a follow-up call by a tool
 * `claims` does not cover may not bring the follow-up calls left below `calls`.
 */
export interface FollowupReserve {
  calls: number;
  claims: (tool: SkillId | null) => boolean;
  active: () => boolean;
}
/** The run (or standalone scope) a network call is charged to. */
export interface BudgetScope {
  readonly runId: string | null;
  /** Null for standalone tools: no run or follow-up cap. */
  readonly limits: RunLimits | null;
  readonly lane: Lane | null;
  readonly phase: () => Phase;
  readonly onWarn?: (warning: QlooBudgetWarning) => void;
  /** Follow-up calls held for a claimant tool (RunScope.reserve); absent for none. */
  readonly reserve?: FollowupReserve;
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
  /** The static daily cap (QLOO_DAILY_FRESH_CAP); the judging window replaces it (dailyFreshCapFor). */
  dailyFreshCap: number;
  /** JUDGING_END_DATE, or null: no dynamic daily cap. */
  judgingEndDate?: string | null;
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
  /** Today's dynamic cap once computed (dailyCap). */
  private dayCap: { day: string; cap: number } | null = null;

  constructor(private readonly options: BudgetGatesOptions) {
    this.tagCap = options.env === "mock" ? null : options.tagCap;
  }

  /**
   * Runs the gates in order and reserves one network call, or throws BudgetError naming the gate. `tool`
   * is the skill the call belongs to (null for bookkeeping), for the run's follow-up reserve.
   */
  reserve(scope: BudgetScope, tool: SkillId | null = null): Promise<Reservation> {
    return this.mutex.run(() => this.check(scope, tool));
  }

  /** Today's prod fresh-call cap: the judging window's dynamic cap, fixed for the UTC day once computed. */
  dailyCap(now: number = this.options.now()): number {
    const day = utcDay(now);
    if (this.dayCap?.day === day) return this.dayCap.cap;
    const monthRemaining = this.options.quota.snapshot().monthRemaining;
    const cap = dailyFreshCapFor({
      staticCap: this.options.dailyFreshCap,
      monthRemaining,
      day,
      judgingEndDate: this.options.judgingEndDate ?? null,
      floor: PROD_MONTH_FLOOR,
    });
    // Recomputed each UTC day from that day's first remaining figure; until one exists, the static cap.
    if (monthRemaining !== null) this.dayCap = { day, cap };
    return cap;
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

  private async check(scope: BudgetScope, tool: SkillId | null): Promise<Reservation> {
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
      const reserve = scope.reserve;
      if (followup && reserve !== undefined && reserve.calls > 0 && !reserve.claims(tool) && reserve.active()) {
        const left = limits.followupCalls - scope.followup;
        if (left <= reserve.calls) {
          throw this.refuse("followup_cap", `the last ${reserve.calls} follow-up Qloo calls are held for the concept test (${left} left)`);
        }
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
      const dailyCap = this.dailyCap();
      const caps: [string, number][] = [["all", dailyCap]];
      if (scope.lane !== null) caps.unshift([scope.lane, Math.floor(dailyCap * LANE_SHARE[scope.lane])]);
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
