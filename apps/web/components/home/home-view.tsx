import type { AskParent } from "../ask/ask-parent";
import { AskBox } from "./ask-box";
import { HowBand } from "./how-band";

export interface HomeViewProps {
  /** /ask?q=: the box opens with it and sends it at once. */
  initialQuestion?: string;
  /** /ask?parent=: the answer the question follows up on. */
  parent?: AskParent | null;
}

/** The hero line, with the design's forced break. */
export const HERO_LINES = ["Ask what any audience", "really loves."] as const;
export const HERO_SUBLINE = "Get a one-page answer from Qloo taste data in about a minute.";

/**
 * Home (N01 at 1440, N17 at 390): the hero, the question box with its inline states, and the how band.
 * /ask renders the same page with its question in the box. Centred on desktop, left-aligned on phones.
 */
export function HomeView({ initialQuestion = "", parent = null }: HomeViewProps) {
  return (
    <div className="flex flex-col items-center pt-[88px] pb-24 max-md:items-stretch max-md:pt-8 max-md:pb-12">
      <h1 className="m-0 text-center type-display-xl text-ink max-md:max-w-[300px] max-md:text-left max-md:type-hero-sm">
        {HERO_LINES[0]}
        <br />
        {HERO_LINES[1]}
      </h1>
      <p className="m-0 mt-4 max-w-[640px] text-center type-lead text-ink-2 max-md:mt-4 max-md:text-left max-md:text-[16px] max-md:leading-6">
        {HERO_SUBLINE}
      </p>
      <AskBox key={parent?.runId ?? ""} initialQuestion={initialQuestion} parent={parent} className="mt-7 max-w-[880px] max-md:mt-6" />
      <HowBand className="mt-28 w-full max-md:mt-12" />
    </div>
  );
}
