import type { Metadata } from "next";
import { SiteShell } from "../../components/chrome/site-shell";
import { Following, FollowingNotes } from "../../components/following/following-view";
import { LEAD_MAIN, LEAD_NOTE } from "../../components/following/model";

export const metadata: Metadata = {
  title: "Following · Culture Terminal",
  // Every browser sees only its own follows (D31): nothing here to index.
  robots: { index: false, follow: true },
};

/** /following (PLAN §8.1, §2.4): what this browser follows, each with its latest note and [Re-run]. */
export default function FollowingPage() {
  return (
    <SiteShell active="following" mainClassName="pt-12 pb-24 max-md:pt-8 max-md:pb-16">
      <div className="flex items-start gap-14">
        <div className="min-w-0 flex-1">
          <header className="flex flex-col gap-5 pb-10 max-md:pb-8">
            <h1 className="m-0 type-display-m text-ink max-md:type-display-m-sm">Following</h1>
            <div className="flex max-w-[680px] flex-col gap-2">
              <p className="m-0 type-body text-ink">{LEAD_MAIN}</p>
              <p className="m-0 type-label font-normal text-ink-3">{LEAD_NOTE}</p>
            </div>
          </header>
          <Following />
        </div>
        <FollowingNotes className="w-[260px] shrink-0 border-l border-line pt-24 pl-6 max-lg:hidden" />
      </div>
    </SiteShell>
  );
}
