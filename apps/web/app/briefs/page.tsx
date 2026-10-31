import type { Metadata } from "next";
import { SiteShell } from "../../components/chrome/site-shell";
import { YourAnswers } from "../../components/library/your-answers";

export const metadata: Metadata = {
  title: "Your answers · Culture Terminal",
  // Every visitor sees their own list: nothing here to index.
  robots: { index: false, follow: true },
};

/** Your answers: the questions this browser asked, newest first; each row shows its own status. */
export default function YourAnswersPage() {
  return (
    <SiteShell active="answers" mainClassName="pt-12 pb-24 max-md:pt-8 max-md:pb-16">
      <header className="pb-8 max-md:pb-6 motion-safe:animate-rise">
        <h1 className="m-0 type-display-m text-ink max-md:type-display-m-sm">Your answers</h1>
      </header>
      <YourAnswers />
    </SiteShell>
  );
}
