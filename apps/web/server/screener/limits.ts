import "server-only";
import type { DesLimits } from "../des/limits";

/**
 * The screener's own guards, beside the Qloo client's caps (§10.4: the DES tearsheet and the screener
 * draw from the same daily Qloo cap, which the client's lane scope enforces). The limiter is the
 * tearsheet's (server/des/limits.ts): sliding per-visitor and per-process windows, and fresh Qloo calls
 * per UTC day, each screen reserving its whole cap when it starts and giving back what it did not use.
 * A screen served from the answer cache counts toward none of them.
 */

export const DEFAULT_SCREENER_LIMITS: DesLimits = { visitorPerMinute: 4, visitorPerHour: 20, globalPerHour: 120, dailyNetworkCalls: 400 };
