import type { Metadata } from "next";
import { SiteShell } from "../../components/chrome/site-shell";
import { PlanUsage } from "../../components/settings/plan-usage";
import { SettingsLayout } from "../../components/settings/settings-nav";

export const metadata: Metadata = {
  title: "Plan & usage · Culture Terminal",
  description: "Your plan, and how much of each limit you have used and have left.",
  robots: { index: false, follow: false },
};

/** /settings: Plan & usage. The figures are read live in the browser (GET /api/access?usage=1, GET /api/follows). */
export default function SettingsPage() {
  return (
    <SiteShell header="inner">
      <SettingsLayout active="plan">
        <PlanUsage />
      </SettingsLayout>
    </SiteShell>
  );
}
