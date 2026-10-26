import { ANALYST_CONFIGS, CLERK_MODEL, MIN_OK_EVIDENCE, SCAN_TABLE } from "@ct/agent";
import { DEFAULT_RUN_LIMITS, Job, type SkillId } from "@ct/contracts";
import { ALLOW, PROBE_FACTS, type QlooPath } from "@ct/qloo";
import type { MethodFacts } from "../../content/method";
import { endpointLabel, modelLabel, windowEndMonth } from "../../components/method/facts";
import { formatTrendWindow } from "../../lib/brief/format";

// The code facts /method quotes, read on the server from the packages that run every brief (the agent
// and the Qloo client are server-only, so the page passes plain data down).

export function methodFacts(): MethodFacts {
  return {
    clerkModel: modelLabel(CLERK_MODEL),
    analystModel: modelLabel(ANALYST_CONFIGS.live.model),
    limits: DEFAULT_RUN_LIMITS,
    minOkEvidence: MIN_OK_EVIDENCE,
    windowEnd: windowEndMonth(PROBE_FACTS.trendingWindow.end),
  };
}

/** The skills each job's opening scan runs (SCAN_TABLE). */
export function openingScan(): Record<Job, SkillId[]> {
  return Object.fromEntries(Job.options.map((job) => [job, SCAN_TABLE[job].map((entry) => entry.tool)])) as Record<Job, SkillId[]>;
}

/** The Qloo endpoints the client's allowlist admits, as words: "Search · Entities · Insights …". */
export function qlooEndpoints(): string[] {
  return (Object.keys(ALLOW) as QlooPath[]).map(endpointLabel);
}

/** The probe-verified trending window, e.g. "Apr–Sep 2025". */
export function trendWindowText(): string {
  return formatTrendWindow(PROBE_FACTS.trendingWindow);
}
