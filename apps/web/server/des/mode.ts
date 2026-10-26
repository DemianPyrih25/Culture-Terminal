import "server-only";
import type { Lane } from "@ct/contracts";
import { decideMode, type ModeService } from "../breakers";
import type { DesMode } from "./service";

/**
 * A lane's mode for a tearsheet: the mode machine's own inputs and rules (breakers.ts) with today's LLM
 * spend left out, since a tearsheet makes no LLM call. Every other breaker (the stored mode, the Qloo
 * month floor, today's Qloo calls, the operator's override) still steps it down.
 */
export async function desModeFrom(modes: ModeService, lane: Lane, now: number = Date.now()): Promise<DesMode> {
  const inputs = await modes.inputs(now);
  const decision = decideMode(lane, { ...inputs, todayUsd: 0 }, modes.policy, now);
  return { mode: decision.mode, breaker: decision.breaker, reason: decision.reason, until: decision.until };
}
