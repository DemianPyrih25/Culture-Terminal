import { followsUp, type AskParent } from "../ask/ask-parent";
import { AskBox } from "./ask-box";
import { HowBand } from "./how-band";
import { RecentAnswers } from "./recent-answers";

export interface HomeViewProps {
  /** /ask?q=: the box opens with it and sends it at once. */
  initialQuestion?: string;
  /** /ask?parent=: the answer the question follows up on. */
  parent?: AskParent | null;
}

/** The hero statement, in two halves (kept for callers that set the break themselves). */
export const HERO_LINES = ["Ask what any audience", "really loves."] as const;
/** True to the sources: Qloo taste data always; filings, Census figures and place counts only when a question needs them. */
export const HERO_SUBLINE =
  "One plain-English question gives a one-page answer, built from Qloo taste data, with SEC filings, US Census figures and OpenStreetMap place counts where the question needs them.";
/** The follow-up's statement and line, on /ask?parent= when the parent is taken. */
export const FOLLOW_UP_TITLE = "Ask a follow-up about this answer.";
export const FOLLOW_UP_SUBLINE = "A follow-up gets its own one-page answer, read with the answer it came from.";

/** Small-caps section label (Ledger): 11 px, tracked, ink-3. */
const LABEL = "m-0 text-[11px] leading-4 font-semibold tracking-[0.08em] text-ink-3 uppercase";

/**
 * Home (Ledger A): a reading column with a small label, the serif statement and one line, the question
 * box with its inline states, then the visitor's recent answers; how every answer is made sits in a
 * margin rail on wide screens and under the column elsewhere. /ask renders the same page with its
 * question in the box, and a follow-up names itself in the statement.
 */
export function HomeView({ initialQuestion = "", parent = null }: HomeViewProps) {
  const following = followsUp(parent);
  return (
    <div className="mx-auto flex w-full max-w-[1120px] gap-14 pt-14 pb-24 max-xl:flex-col max-xl:gap-16 max-md:pt-8 max-md:pb-12">
      <div className="flex w-full max-w-[760px] min-w-0 flex-1 flex-col">
        <p className={LABEL}>{following ? "Follow-up question" : "New question"}</p>
        <h1 className="m-0 mt-3.5 font-display text-[44px] leading-[52px] font-medium tracking-[-0.015em] text-ink max-md:text-[32px] max-md:leading-[40px]">
          {following ? FOLLOW_UP_TITLE : `${HERO_LINES[0]} ${HERO_LINES[1]}`}
        </h1>
        <p className="m-0 mt-4 max-w-[620px] type-body text-ink-2">{following ? FOLLOW_UP_SUBLINE : HERO_SUBLINE}</p>
        <AskBox key={parent?.runId ?? ""} initialQuestion={initialQuestion} parent={parent} className="mt-10 max-md:mt-7" />
        <RecentAnswers className="mt-16 max-md:mt-12" />
      </div>
      <aside aria-labelledby="how-title" className="w-[280px] shrink-0 pt-2 max-xl:w-full max-xl:max-w-[760px]">
        <h2 id="how-title" className={`${LABEL} border-b border-line pb-2`}>
          How every answer is made
        </h2>
        <HowBand className="mt-4" />
      </aside>
    </div>
  );
}
