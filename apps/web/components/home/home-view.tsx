import { followsUp, type AskParent } from "../ask/ask-parent";
import { AskBox } from "./ask-box";
import { FollowingPreviewLazy as FollowingPreview } from "./following-preview-lazy";
import { RecentAnswers } from "./recent-answers";
import { WhatToAsk } from "./what-to-ask";

export interface HomeViewProps {
  /** /ask?q=: the box opens with it and sends it at once. */
  initialQuestion?: string;
  /** /ask?parent=: the answer the question follows up on. */
  parent?: AskParent | null;
}

/** The hero statement, in two halves (kept for callers that set the break themselves). */
export const HERO_LINES = ["Ask what any audience", "really loves."] as const;
/** The follow-up's statement, on /ask?parent= when the parent is taken. */
export const FOLLOW_UP_TITLE = "Ask a follow-up about this answer.";
export { MAP_COVERAGE } from "./map-coverage";

/** Small-caps section label (Ledger): 11 px, tracked. */
const LABEL = "m-0 text-[11px] leading-4 font-semibold tracking-[0.08em] text-ink-2 uppercase";

/**
 * Home (Ledger A): one reading column with a small label, the serif statement, the question box with its
 * inline states, then the visitor's recent answers and follows. /ask renders the same page with its
 * question in the box, and a follow-up names itself.
 */
export function HomeView({ initialQuestion = "", parent = null }: HomeViewProps) {
  const following = followsUp(parent);
  return (
    <div className="mx-auto flex w-full max-w-[780px] flex-col pt-14 pb-16 max-md:pt-8 max-md:pb-12">
      <div className="flex animate-rise flex-col gap-3.5 pb-9 max-md:pb-6">
        <p className={LABEL}>{following ? "Follow-up question" : "New question"}</p>
        <h1 className="m-0 font-display text-[44px] leading-[52px] font-normal tracking-[-0.015em] text-ink max-md:text-[32px] max-md:leading-[40px]">
          {following ? FOLLOW_UP_TITLE : `${HERO_LINES[0]} ${HERO_LINES[1]}`}
        </h1>
      </div>
      <AskBox key={parent?.runId ?? ""} initialQuestion={initialQuestion} parent={parent} className="animate-rise [animation-delay:60ms]" />
      {following ? null : <WhatToAsk className="mt-5" />}
      <RecentAnswers className="mt-14 max-md:mt-10" />
      <FollowingPreview className="mt-14 max-md:mt-10" />
    </div>
  );
}
