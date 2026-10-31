"use client";

import type { ReactNode } from "react";
import { FOLLOWS_PER_VISITOR_MAX } from "@ct/contracts/values";
import { useFollows } from "../following/follow-button";
import { useAccess } from "../protection/use-access";
import { cx } from "../ui/cx";
import { laneName, secondsWords, serviceView, type PlanFacts, type ServiceView } from "./plan-facts";
import { SETTINGS_LABEL } from "./settings-nav";

const TONE_DOT: Record<ServiceView["tone"], string> = {
  good: "bg-good",
  caution: "bg-caution",
  danger: "bg-danger",
  muted: "bg-ink-3",
};

function Section({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className={SETTINGS_LABEL}>
        {label}
      </h2>
      <div className="rounded-card border border-line bg-surface">{children}</div>
    </section>
  );
}

/** One figure in a row of three: a label over a mono number and its unit. */
function Figure({ label, value, unit }: { label: string; value: ReactNode; unit: string }) {
  return (
    <div className="flex flex-col gap-1 px-6 py-5 max-md:px-5 max-md:py-4">
      <dt className="text-[13px] leading-[18px] text-ink-3">{label}</dt>
      <dd className="flex items-baseline gap-1.5">
        <span className="font-mono text-[22px] leading-7 text-ink tabular-nums">{value}</span>
        <span className="text-[13px] leading-[18px] text-ink-2">{unit}</span>
      </dd>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 px-6 py-4 max-md:flex-col max-md:gap-1 max-md:px-5">
      <dt className="text-[14px] leading-5 text-ink">{label}</dt>
      <dd className="text-right text-[14px] leading-5 text-ink-2 max-md:text-left">{children}</dd>
    </div>
  );
}

/**
 * Settings > Plan & usage: the visitor's access and its state (GET /api/access), the answer limits in
 * force on this server, the run queue, and Following and Screener allowances. Every figure is the
 * running server's own setting or a live read; nothing here is a sample.
 */
export function PlanUsage({ facts }: { facts: PlanFacts }) {
  const access = useAccess();
  const follows = useFollows();
  const lane = access?.lane;
  const review = lane === "judge";
  const service = serviceView(access === null ? undefined : access.mode, access?.message ?? null, access?.until ?? null);
  const limits = review
    ? { atOnce: facts.review.slots, perHour: facts.review.perHour, perDay: facts.review.perDay }
    : { atOnce: facts.visitor.maxActive, perHour: facts.visitor.perHour, perDay: facts.visitor.perDay };
  const followMax = follows.kind === "ready" ? follows.max : FOLLOWS_PER_VISITOR_MAX;

  return (
    <div className="flex flex-col gap-10 max-md:gap-8" data-testid="settings-plan">
      <header className="flex flex-col gap-2">
        <h1 className="type-display-m text-ink max-md:type-display-m-sm">Plan &amp; usage</h1>
        <p className="text-[15px] leading-6 text-ink-2">Your access, the limits on new answers and how they count.</p>
      </header>

      <Section label="Plan" id="settings-plan-access">
        <div className="flex flex-col gap-4 px-6 py-6 max-md:px-5 max-md:py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-display text-[24px] leading-8 text-ink">{access ? laneName(lane) : " "}</p>
            <p className="flex items-center gap-2 text-[13px] leading-[18px] text-ink-2" aria-live="polite">
              <span aria-hidden className={cx("size-2 rounded-full", TONE_DOT[service.tone])} />
              <span className="font-medium text-ink">{service.label}</span>
            </p>
          </div>
          <p className="text-[14px] leading-[22px] text-ink-2">
            {review
              ? "This browser holds a review pass. Its answers run on capacity held for reviewers, shared by everyone with a pass."
              : "There are no paid plans or billing yet. Everyone uses the same open access, with the limits below."}
          </p>
          {service.detail ? <p className="border-t border-line pt-4 text-[13px] leading-5 text-ink-2">{service.detail}</p> : null}
        </div>
      </Section>

      <Section label="Answer limits" id="settings-plan-limits">
        <dl className="grid grid-cols-3 divide-x divide-line max-md:grid-cols-1 max-md:divide-x-0 max-md:divide-y">
          <Figure label="At once" value={limits.atOnce} unit={limits.atOnce === 1 ? "answer" : "answers"} />
          <Figure label="Per hour" value={limits.perHour} unit={limits.perHour === 1 ? "answer" : "answers"} />
          <Figure label="Per 24 hours" value={limits.perDay} unit={limits.perDay === 1 ? "answer" : "answers"} />
        </dl>
        <p className="border-t border-line px-6 py-4 text-[13px] leading-5 text-ink-2 max-md:px-5">
          {review
            ? "Counted for all review passes together. "
            : "Counted per visitor. "}
          Each new answer counts for an hour and for 24 hours after it starts. Answers you already have, cached
          answers and replays do not count.
        </p>
      </Section>

      <Section label="Queue" id="settings-plan-queue">
        <dl className="divide-y divide-line">
          <Row label="When the server is busy">
            {facts.queue.max > 0
              ? `New answers wait in order, up to ${secondsWords(facts.queue.waitS)}`
              : "New answers are refused until a slot frees"}
          </Row>
        </dl>
      </Section>

      <Section label="Following and screener" id="settings-plan-other">
        <dl className="divide-y divide-line">
          <Row label="Following">
            {follows.kind === "ready" ? (
              <span className="font-mono tabular-nums">
                <span className="text-ink">{follows.follows.length}</span> of {followMax}
              </span>
            ) : (
              <span className="font-mono tabular-nums">Up to {followMax}</span>
            )}
          </Row>
          <Row label="Screener">
            <span className="font-mono tabular-nums">
              {facts.screener.perMinute} a minute · {facts.screener.perHour} an hour
            </span>
          </Row>
        </dl>
      </Section>

      <p className="text-[13px] leading-5 text-ink-3">
        A running count of the answers you have used today is not shown yet. When a limit is reached, the question
        box says so and when you can ask again.
      </p>
    </div>
  );
}
