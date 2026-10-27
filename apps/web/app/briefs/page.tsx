import type { Metadata } from "next";
import { SiteShell } from "../../components/chrome/site-shell";
import { YourAnswers } from "../../components/library/your-answers";

export const metadata: Metadata = {
  title: "Your answers · Culture Terminal",
  // Every visitor sees their own list: nothing here to index.
  robots: { index: false, follow: true },
};

/** Your answers (N13 row style): the questions this browser asked, newest first. */
export default function YourAnswersPage() {
  return (
    <SiteShell active="answers" mainClassName="pt-12 pb-24 max-md:pt-8 max-md:pb-12">
      <h1 className="m-0 type-display-m text-ink max-md:type-display-m-sm">Your answers</h1>
      <p className="m-0 mt-3 type-lead text-ink-2 max-md:text-[16px] max-md:leading-6">
        The questions you asked on this browser. Each one opens its answer.
      </p>
      <YourAnswers className="mt-8" />
    </SiteShell>
  );
}
