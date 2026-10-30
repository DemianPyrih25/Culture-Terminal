import type { Metadata } from "next";
import { SiteShell } from "../../components/chrome/site-shell";
import { Following } from "../../components/following/following-view";
import { LEAD_TEXT } from "../../components/following/model";

export const metadata: Metadata = {
  title: "Following · Culture Terminal",
  // Every browser sees only its own follows (D31): nothing here to index.
  robots: { index: false, follow: true },
};

/** /following (PLAN §8.1, §2.4): what this browser follows, each with its latest note and [Re-run]. */
export default function FollowingPage() {
  return (
    <SiteShell active="following" mainClassName="pt-12 pb-24 max-md:pt-8 max-md:pb-12">
      <h1 className="m-0 type-display-m text-ink max-md:type-display-m-sm">Following</h1>
      <p className="m-0 mt-3 max-w-[760px] type-lead text-ink-2 max-md:text-[16px] max-md:leading-6">{LEAD_TEXT}</p>
      <Following className="mt-8" />
    </SiteShell>
  );
}
