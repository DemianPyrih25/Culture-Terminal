import { ANSWERS_HREF } from "../chrome/links";
import type { AskNotice } from "../ask/ask-machine";
import { Button, ButtonLink } from "../ui/button";
import { Chip } from "../ui/chip";
import type { IconName } from "../ui/icons";
import { InlineState, type InlineStateTone } from "../ui/inline-state";

const LOOK: Readonly<Record<AskNotice["kind"], { tone: InlineStateTone; icon: IconName }>> = {
  paused: { tone: "neutral", icon: "circle-pause" },
  refused: { tone: "neutral", icon: "ban" },
  needs_input: { tone: "neutral", icon: "circle-question-mark" },
  limited: { tone: "neutral", icon: "clock-4" },
  error: { tone: "neutral", icon: "triangle-alert" },
  run_failed: { tone: "danger", icon: "circle-x" },
};

/** Where the visitor's plan and usage live: the only page that shows limits. */
export const PLAN_HREF = "/settings";

/** The one calm line a used-up day shows on Home, in place of the server's limit or budget wording. */
export const DAILY_CAP_TEXT = "You've used today's answers. They reset at 00:00 UTC.";

/** A run that did not start because today's limit or budget is used up: trying again cannot pass. */
export function isDailyCap(notice: AskNotice): boolean {
  return notice.kind === "run_failed" && /today's (limit|budget)/i.test(notice.text);
}

/** A limit that lifts only with time (hourly or daily): "Try again" would only fail again. */
function isLimit(notice: AskNotice): boolean {
  return notice.kind === "run_failed" && /(hourly|today's) (limit|budget)/i.test(notice.text);
}

export interface AskNoticeViewProps {
  notice: AskNotice;
  /** The id the field's aria-describedby names. */
  id?: string;
  /** Asks a refusal's reframe. */
  onReframe?: (question: string) => void;
  /** Sends the question again (an error that may pass, a run that did not start). */
  onRetry?: () => void;
  className?: string;
}

/**
 * The one inline state under the question box: one sentence and at most one action. Paused and limited
 * link to the visitor's own answers; a refusal offers its reframe as a chip that asks it; needs input
 * has no button (the box keeps focus); an error and a run that did not start try again. A used-up day
 * says so calmly and links to the plan; an hourly limit offers nothing that would only fail again.
 */
export function AskNoticeView({ notice, id, onReframe, onRetry, className }: AskNoticeViewProps) {
  if (isDailyCap(notice)) {
    return (
      <InlineState
        id={id}
        tone="caution"
        icon="clock-4"
        role="alert"
        data-notice={notice.kind}
        data-cap="daily"
        className={className}
        action={<ButtonLink href={PLAN_HREF}>See plan</ButtonLink>}
      >
        <p className="m-0">{DAILY_CAP_TEXT}</p>
      </InlineState>
    );
  }
  const look = LOOK[notice.kind];
  let action = null;
  if (isLimit(notice)) {
    action = null;
  } else if (notice.kind === "paused" || notice.kind === "limited") {
    action = (
      <ButtonLink href={ANSWERS_HREF}>
        Your answers
      </ButtonLink>
    );
  } else if ((notice.kind === "error" && notice.retry) || notice.kind === "run_failed") {
    action = onRetry ? (
      <Button icon="rotate-ccw" onClick={onRetry}>
        Try again
      </Button>
    ) : null;
  }
  const alert = notice.kind === "run_failed" || notice.kind === "error";
  return (
    <InlineState
      id={id}
      tone={look.tone}
      icon={look.icon}
      action={action}
      role={alert ? "alert" : undefined}
      data-notice={notice.kind}
      className={className}
    >
      <p className="m-0">{notice.text}</p>
      {notice.kind === "refused" && notice.reframe !== null ? (
        <Chip variant="go" className="mt-3 max-w-full" onClick={() => onReframe?.(notice.reframe ?? "")}>
          {notice.reframe}
        </Chip>
      ) : null}
    </InlineState>
  );
}
