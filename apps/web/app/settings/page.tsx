import type { Metadata } from "next";
import { SiteShell } from "../../components/chrome/site-shell";
import { PlanUsage } from "../../components/settings/plan-usage";
import type { PlanFacts } from "../../components/settings/plan-facts";
import { SettingsLayout } from "../../components/settings/settings-nav";
import {
  judgeRunDailyCapFromEnv,
  judgeRunHourlyCapFromEnv,
  judgeRunMaxActiveFromEnv,
  runQueueMaxFromEnv,
  runQueueWaitSFromEnv,
  visitorLimitsFromEnv,
} from "../../server/config";
import { DEFAULT_SCREENER_LIMITS } from "../../server/screener/limits";

// Read per request: the limits are this server's running config, which an operator may change.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Plan & usage · Culture Terminal",
  description: "Your access, the limits on new answers and how they count.",
  robots: { index: false, follow: false },
};

/** The figures the running server enforces, as plain numbers for the client page. */
function planFacts(): PlanFacts {
  return {
    visitor: visitorLimitsFromEnv(),
    review: { slots: judgeRunMaxActiveFromEnv(), perHour: judgeRunHourlyCapFromEnv(), perDay: judgeRunDailyCapFromEnv() },
    queue: { max: runQueueMaxFromEnv(), waitS: runQueueWaitSFromEnv() },
    screener: { perMinute: DEFAULT_SCREENER_LIMITS.visitorPerMinute, perHour: DEFAULT_SCREENER_LIMITS.visitorPerHour },
  };
}

/** /settings: Plan & usage, the only settings section while there are no accounts. */
export default function SettingsPage() {
  return (
    <SiteShell header="inner">
      <SettingsLayout active="plan">
        <PlanUsage facts={planFacts()} />
      </SettingsLayout>
    </SiteShell>
  );
}
