"use client";

import { useState, type ReactNode } from "react";
import { Button, ButtonLink } from "../ui/button";
import { ChartCard } from "../ui/chart-card";
import { Hatch } from "../ui/skeleton";
import { KeyNumber } from "../ui/key-number";
import { FollowButton, profileFollowOption } from "../following";
import { Monogram } from "../ui/monogram";
import { cx } from "../ui/cx";
import { useToast } from "../ui/toast";
import { EYEBROW } from "./eyebrow";
import { LookUpAnother } from "./look-up";
import { ProfileDrawer, type HowTarget } from "./profile-drawer";
import type { ProfileModel } from "./profile-model";
import { DivergingRows, FansTable, NeighbourColumns, NeighboursTable, TagGroups, TravelBars, TravelTable } from "./profile-plots";

/**
 * The audience profile (N14 QrdGr): the entity header, three key numbers, who the fans are and how Qloo
 * describes the name, what else their fans love, and the places their fans travel to. Every Source opens
 * How we know on the request behind it.
 */

/** The cards' small-caps kind line and Source in ink-2, so they read clearly on white. */
const CARD = "[&_.type-overline]:text-ink-2 [&_button]:text-ink-2";

function EntityHeader({ profile, onHow }: { profile: ProfileModel; onHow: () => void }) {
  return (
    <header className="flex animate-rise flex-col gap-5 max-md:gap-4" data-entity-header="true">
      <div className="flex min-w-0 items-center gap-4">
        <Monogram name={profile.name} size={56} palette="subject" className="max-md:hidden" />
        <Monogram name={profile.name} size={48} palette="subject" className="md:hidden" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className={EYEBROW} data-label-line="true">
            {profile.labelLine}
          </p>
          <h1 className="font-display text-[42px] leading-[48px] font-medium tracking-[-0.01em] break-words text-ink max-md:type-display-m-sm">{profile.name}</h1>
        </div>
      </div>
      {profile.lookedUpAs ? <p className="text-[12px] leading-4 text-ink-2">Looked up as “{profile.lookedUpAs}”.</p> : null}
      <div className="flex flex-wrap items-start gap-2 max-md:w-full">
        <ButtonLink href={profile.askHref} prefetch={false} variant="primary" className="max-md:w-full max-md:justify-center">
          Ask about {profile.name}
        </ButtonLink>
        <LookUpAnother type={profile.type} />
        {profile.type === "brand" ? <FollowButton option={profileFollowOption(profile.name)} /> : null}
        <Button variant="quiet" icon="shield-check" onClick={onHow} className="md:ml-auto">
          How we know
        </Button>
      </div>
    </header>
  );
}

/** A block that fades in and rises 8 px once, on arrival (CSS only, so it never replays on re-render). */
function Rise({ delay = 0, className, children }: { delay?: number; className?: string; children: ReactNode }) {
  return (
    <div className={cx("animate-rise", className)} style={{ animationDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

/** A card body when a part has no data: the hatch and why. */
function Empty({ gap }: { gap: string | null }) {
  return (
    <div className="flex flex-col gap-3">
      <Hatch className="min-h-24 rounded-sm" />
      {gap ? <p className="type-label font-normal text-ink-2">{gap}</p> : null}
    </div>
  );
}

/** A part that came back incomplete says so under its plot. */
function caption(text: string, gap: string | null): ReactNode {
  return gap ? (
    <>
      {text} <span className="text-caution-ink">{gap}</span>
    </>
  ) : (
    text
  );
}

export function ProfileView({ profile }: { profile: ProfileModel }) {
  const [how, setHow] = useState<HowTarget | null>(null);
  const { show, toast } = useToast();
  const source = (receipt: number | null) => (receipt === null ? undefined : () => setHow({ tab: "sources", receipt }));
  const selected = (receipt: number | null) => how?.tab === "sources" && receipt !== null && how.receipt === receipt;
  const { fans, tags, neighbours, travel } = profile;

  return (
    <div className="pt-9 pb-16 max-md:pt-6 max-md:pb-10" data-profile="true">
      <div className="flex min-w-0 flex-col gap-8 max-md:gap-6">
        <EntityHeader profile={profile} onHow={() => setHow({ tab: "summary", receipt: null })} />

        <div className="flex flex-col gap-10 max-md:gap-5">
          <section aria-label="Key numbers" className="grid grid-cols-3 gap-4 max-md:grid-cols-1 max-md:gap-3">
            {profile.keyNumbers.map((k, i) => (
              <Rise key={k.id} delay={60 + i * 40} className="flex flex-col [&>*]:flex-1">
              <KeyNumber
                variant="word"
                value={k.value}
                label={k.label}
                context={k.context}
                onSource={source(k.receipt)}
                selected={selected(k.receipt)}
              />
              </Rise>
            ))}
          </section>

          <Rise delay={180} className="grid grid-cols-2 gap-6 max-lg:grid-cols-1 max-md:gap-4">
            <ChartCard
              kind="Who the fans are"
              title={fans.title}
              titleAs="h2"
              stacked
              onSource={source(fans.receipt)}
              table={fans.rows.length > 0 ? <FansTable rows={fans.rows} label={fans.title} /> : undefined}
              caption={fans.rows.length > 0 ? caption("Relative to the average audience, not shares of customers.", fans.gap) : undefined}
              className={cx(CARD, "h-full [&>[data-view]]:flex-1")}
            >
              {fans.rows.length > 0 ? <DivergingRows rows={fans.rows} label={fans.title} /> : <Empty gap={fans.gap} />}
            </ChartCard>
            <ChartCard
              kind="How Qloo describes it"
              title={tags.title}
              titleAs="h2"
              stacked
              onSource={source(tags.receipt)}
              caption={tags.families.length > 0 ? tags.caption : undefined}
              className={cx(CARD, "h-full [&>[data-view]]:flex-1")}
            >
              {tags.families.length > 0 ? <TagGroups families={tags.families} /> : <Empty gap={tags.gap} />}
            </ChartCard>
          </Rise>

          <Rise delay={240}>
          <ChartCard
            kind="What else their fans love"
            title={neighbours.title}
            titleAs="h2"
            stacked
            className={CARD}
            onSource={source(neighbours.receipt)}
            table={neighbours.columns.length > 0 ? <NeighboursTable columns={neighbours.columns} label={neighbours.title} /> : undefined}
            caption={
              neighbours.columns.length > 0 ? caption("Ranked by how much more these fans like them than average.", neighbours.gap) : undefined
            }
          >
            {neighbours.columns.length > 0 ? <NeighbourColumns columns={neighbours.columns} /> : <Empty gap={neighbours.gap} />}
          </ChartCard>
          </Rise>

          <Rise delay={300}>
          <ChartCard
            kind="Places their fans travel to"
            title={travel.title}
            titleAs="h2"
            stacked
            className={CARD}
            onSource={source(travel.receipt)}
            table={travel.rows.length > 0 ? <TravelTable rows={travel.rows} label={travel.title} /> : undefined}
            caption={travel.rows.length > 0 ? caption("Places their fans are drawn to, not where they live.", travel.gap) : undefined}
          >
            {travel.rows.length > 0 ? <TravelBars rows={travel.rows} label={travel.title} /> : <Empty gap={travel.gap} />}
          </ChartCard>
          </Rise>
        </div>
      </div>

      <ProfileDrawer how={profile.how} target={how} onTarget={setHow} onClose={() => setHow(null)} onCopied={() => show("Copied")} />
      {toast}
    </div>
  );
}
