import type { Metadata } from "next";
import { SiteShell } from "../../components/chrome/site-shell";
import { Following } from "../../components/following/following-view";
import { LEAD_NOTE } from "../../components/following/model";
import { Icon } from "../../components/ui/icons";

export const metadata: Metadata = {
  title: "Following · Culture Terminal",
  // Every browser sees only its own follows (D31): nothing here to index.
  robots: { index: false, follow: true },
};

/** /following (PLAN §8.1, §2.4): what this browser follows, each with its latest note and [Re-run]. */
export default function FollowingPage() {
  return (
    <SiteShell active="following" mainClassName="pt-12 pb-24 max-md:pt-8 max-md:pb-16">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 pb-8 max-md:pb-6 motion-safe:animate-rise">
        <h1 className="m-0 type-display-m text-ink max-md:type-display-m-sm">Following</h1>
        <span className="inline-flex items-center gap-1.5 text-[12px] leading-4 text-ink-2">
          <Icon name="circle-pause" size={13} className="shrink-0 text-ink-3" />
          {LEAD_NOTE}
        </span>
      </header>
      <Following />
    </SiteShell>
  );
}
