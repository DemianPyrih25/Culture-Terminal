import { inlineText, type BriefPrior, type PriorState } from "../../lib/brief";
import { Card, CardTitle, cx, Icon, type IconName } from "../ui";

/**
 * C/GuessesCard and C/GuessRow: what the AI guessed before it looked at any data, and how each guess
 * fared once the numbers were checked. Full width before any number arrives; a side column after.
 */

export type GuessState = "waiting" | "data-in" | "expected" | "surprise" | "cant-tell";

const GUESS_STATE: Readonly<Record<PriorState, GuessState>> = {
  awaiting_data: "waiting",
  awaiting_check: "data-in",
  confirmed: "expected",
  refuted: "surprise",
  inconclusive: "cant-tell",
  not_scored: "cant-tell",
};

const LOOK: Readonly<Record<GuessState, { icon: IconName; iconClass: string; word: string; wordClass: string }>> = {
  waiting: { icon: "circle-dashed", iconClass: "text-ink-2", word: "Waiting for data", wordClass: "text-ink-2" },
  "data-in": { icon: "circle-dot", iconClass: "text-accent-ink", word: "Data in", wordClass: "text-accent-ink" },
  expected: { icon: "check", iconClass: "text-good-ink", word: "As expected", wordClass: "text-good-ink" },
  surprise: { icon: "zap", iconClass: "text-second", word: "Surprise", wordClass: "text-second-ink" },
  "cant-tell": { icon: "minus", iconClass: "text-ink-2", word: "Can't tell yet", wordClass: "text-ink-2" },
};

/** The guess as the AI wrote it, without the brief's "We expected: ". */
export function guessStatement(prior: Pick<BriefPrior, "expected">): string {
  return prior.expected.replace(/^We expected:\s*/, "");
}

export interface Guess {
  id: string;
  state: GuessState;
  statement: string;
  /** "Measured: fans lean 35–54." on a surprise; the measured line elsewhere; why it was not scored. */
  note: string | null;
}

/** A prior of the brief model as a guess row. */
export function guessOf(prior: BriefPrior): Guess {
  const state = GUESS_STATE[prior.state];
  const measured = prior.measured ? inlineText(prior.measured).replace(/\s+/g, " ").trim() : "";
  let note: string | null = null;
  if (prior.state === "not_scored") note = "The run stopped before the check.";
  else if (measured !== "") note = state === "surprise" ? measured : measured.replace(/^Measured:\s*/, "").replace(/^./, (c) => c.toUpperCase());
  return { id: prior.id, state, statement: guessStatement(prior), note };
}

export function GuessRow({ guess }: { guess: Guess }) {
  const look = LOOK[guess.state];
  return (
    <li className="flex min-w-0 flex-col gap-1" data-guess={guess.state}>
      <p className={cx("flex items-center gap-1.5 text-[13px] leading-[18px] font-semibold", look.wordClass)}>
        <Icon name={look.icon} size={16} className={cx("shrink-0", look.iconClass)} />
        {look.word}
      </p>
      <p
        className={cx(
          "type-body text-ink",
          guess.state === "surprise" && "line-through decoration-second decoration-[1.5px]",
        )}
      >
        {guess.statement}
      </p>
      {guess.note ? <p className="type-label text-ink-2">{guess.note}</p> : null}
    </li>
  );
}

/** The captions: while live, and once the answer is checked. */
export const GUESS_CAPTION = {
  before: "Written before any data. Scored once every number is checked.",
  side: "Scored once every number is checked.",
  finished: "Written before any data. Scored after every number was checked.",
} as const;

export interface GuessesCardProps {
  priors: readonly BriefPrior[];
  /** full: the wide card before any number arrives. side: the column beside a chart. */
  variant?: "full" | "side";
  /** Default per variant (the live captions); the answer page passes GUESS_CAPTION.finished. */
  caption?: string;
  className?: string;
}

export function GuessesCard({ priors, variant = "side", caption, className }: GuessesCardProps) {
  if (priors.length === 0) return null;
  const full = variant === "full";
  const guesses = priors.map(guessOf);
  return (
    <Card data-guesses={variant} className={cx("flex flex-col", className)}>
      <CardTitle icon="lightbulb">{full ? "Before looking at the data, we guessed" : "We guessed, then checked"}</CardTitle>
      <ul className={cx("flex flex-col gap-6", full && "md:grid md:grid-cols-3 md:gap-x-6 md:gap-y-4")}>
        {guesses.map((g) => (
          <GuessRow key={g.id} guess={g} />
        ))}
      </ul>
      <p className={cx("mt-auto type-caption text-ink-2", full ? "pt-6" : "pt-6")}>{caption ?? (full ? GUESS_CAPTION.before : GUESS_CAPTION.side)}</p>
    </Card>
  );
}
