import type { Metadata } from "next";
import { SiteShell } from "../../components/chrome/site-shell";
import { YourAnswers, YourAnswersNotes } from "../../components/library/your-answers";

export const metadata: Metadata = {
  title: "Your answers · Culture Terminal",
  // Every visitor sees their own list: nothing here to index.
  robots: { index: false, follow: true },
};

/** Your answers: the questions this browser asked, newest first, with a margin key on wide screens. */
export default function YourAnswersPage() {
  return (
    <SiteShell active="answers" mainClassName="pt-12 pb-24 max-md:pt-8 max-md:pb-16">
      <div className="flex items-start gap-14">
        <div className="min-w-0 flex-1">
          <header className="flex flex-col gap-4 pb-10 max-md:pb-8">
            <h1 className="m-0 type-display-m text-ink max-md:type-display-m-sm">Your answers</h1>
            <p className="m-0 max-w-[640px] type-body text-ink-2">The questions you asked on this browser. Each one opens its answer.</p>
          </header>
          <YourAnswers />
        </div>
        <YourAnswersNotes className="w-[240px] shrink-0 border-l border-line pt-2 pl-6 max-lg:hidden" />
      </div>
    </SiteShell>
  );
}
