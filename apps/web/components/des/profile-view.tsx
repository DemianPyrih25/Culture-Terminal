"use client";

import { useState, type ReactNode } from "react";
import { Button, ButtonLink } from "../ui/button";
import { ChartCard } from "../ui/chart-card";
import { Hatch } from "../ui/skeleton";
import { KeyNumber } from "../ui/key-number";
import { FollowButton, profileFollowOption } from "../following";
import { Monogram } from "../ui/monogram";
import { Icon } from "../ui/icons";
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

function EntityHeader({ profile, onHow }: { profile: ProfileModel; onHow: () => void }) {
  return (
    <header className="flex flex-col gap-5 border-b border-line pb-6 max-md:gap-4 max-md:pb-5" data-entity-header="true">
      <div className="flex min-w-0 items-center gap-4">
        <Monogram name={profile.name} size={56} palette="subject" className="max-md:hidden" />
        <Monogram name={profile.name} size={48} palette="subject" className="md:hidden" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className={EYEBROW} data-label-line="true">
            {profile.labelLine}
          </p>
          <h1 className="type-display-m break-words text-ink max-md:type-display-m-sm">{profile.name}</h1>
        </div>
      </div>
      <p className="max-w-[640px] type-body text-ink-2 md:text-[16px] md:leading-[26px]">
        Who its fans are, what else they love, and where their taste travels.
        {profile.lookedUpAs ? <span className="mt-1 block type-label font-normal text-ink-3">Looked up as “{profile.lookedUpAs}”.</span> : null}
      </p>
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

/** The margin rail beside the profile on wide screens: what was checked, the limits, following and freshness. */
function MarginRail({ profile, onSources }: { profile: ProfileModel; onSources: () => void }) {
  const { how } = profile;
  const all = how.total > 0 && how.traced === how.total;
  return (
    <aside aria-label="About this profile" className="flex flex-col gap-8 max-xl:hidden" data-profile-rail="true">
      <section className="flex flex-col gap-3">
        <h2 className={EYEBROW}>How we know</h2>
        <ul className="flex flex-col gap-2.5 type-label font-normal text-ink-2">
          <li className="flex gap-2">
            <Icon
              name={all ? "badge-check" : "triangle-alert"}
              size={14}
              className={all ? "mt-0.5 shrink-0 text-good" : "mt-0.5 shrink-0 text-caution"}
            />
            {all ? `All ${how.total} numbers traced to a Qloo request.` : `${how.traced} of ${how.total} numbers traced to a Qloo request.`}
          </li>
          <li className="flex gap-2">
            <Icon name="circle-check" size={14} className="mt-0.5 shrink-0 text-ink-3" />
            {how.matched}
          </li>
          <li className="flex gap-2">
            <Icon name="circle-check" size={14} className="mt-0.5 shrink-0 text-ink-3" />
            Code only. No AI model writes or reads any of this page.
          </li>
        </ul>
        <button
          type="button"
          onClick={onSources}
          className="inline-flex w-fit items-center gap-1.5 type-label text-accent hover:text-accent-hover hover:underline"
        >
          Sources ({how.sources.length})
          <Icon name="arrow-right" size={14} />
        </button>
      </section>
      {how.notes.length > 0 ? (
        <section className="flex flex-col gap-3 border-t border-line pt-6">
          <h2 className={EYEBROW}>Good to know</h2>
          <ul className="flex flex-col gap-2.5">
            {how.notes.map((note) => (
              <li key={note} className="flex gap-2 type-label font-normal text-ink-2">
                <span aria-hidden="true" className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-3" />
                {note}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {profile.type === "brand" ? (
        <section className="flex flex-col gap-3 border-t border-line pt-6">
          <h2 className={EYEBROW}>Following</h2>
          <p className="type-label font-normal text-ink-2">
            Follow saves one question you can re-run at any time: how healthy {profile.name}&apos;s audience taste is, and who its nearest substitutes
            are.
          </p>
        </section>
      ) : null}
      <section className="flex flex-col gap-3 border-t border-line pt-6">
        <h2 className={EYEBROW}>Freshness</h2>
        <p className="type-label font-normal text-ink-2">A profile is read from Qloo again after one hour.</p>
      </section>
    </aside>
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
    <div className="grid grid-cols-1 gap-12 pt-12 pb-16 max-md:pt-6 max-md:pb-10 xl:grid-cols-[minmax(0,1fr)_240px]" data-profile="true">
      <div className="flex min-w-0 flex-col gap-8 max-md:gap-6">
        <EntityHeader profile={profile} onHow={() => setHow({ tab: "summary", receipt: null })} />

        <div className="flex flex-col gap-8 max-md:gap-5">
          <section aria-label="Key numbers" className="grid grid-cols-3 gap-4 max-md:grid-cols-1 max-md:gap-3">
            {profile.keyNumbers.map((k) => (
              <KeyNumber
                key={k.id}
                variant="word"
                value={k.value}
                label={k.label}
                context={k.context}
                onSource={source(k.receipt)}
                selected={selected(k.receipt)}
              />
            ))}
          </section>

          <div className="grid grid-cols-2 gap-6 max-lg:grid-cols-1 max-md:gap-4">
            <ChartCard
              kind="Who the fans are"
              title={fans.title}
              titleAs="h2"
              stacked
              onSource={source(fans.receipt)}
              table={fans.rows.length > 0 ? <FansTable rows={fans.rows} label={fans.title} /> : undefined}
              caption={fans.rows.length > 0 ? caption("Relative to the average audience, not shares of customers.", fans.gap) : undefined}
              className="h-full [&>[data-view]]:flex-1"
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
              className="h-full [&>[data-view]]:flex-1"
            >
              {tags.families.length > 0 ? <TagGroups families={tags.families} /> : <Empty gap={tags.gap} />}
            </ChartCard>
          </div>

          <ChartCard
            kind="What else their fans love"
            title={neighbours.title}
            titleAs="h2"
            stacked
            onSource={source(neighbours.receipt)}
            table={neighbours.columns.length > 0 ? <NeighboursTable columns={neighbours.columns} label={neighbours.title} /> : undefined}
            caption={
              neighbours.columns.length > 0 ? caption("Ranked by how much more these fans like them than average.", neighbours.gap) : undefined
            }
          >
            {neighbours.columns.length > 0 ? <NeighbourColumns columns={neighbours.columns} /> : <Empty gap={neighbours.gap} />}
          </ChartCard>

          <ChartCard
            kind="Places their fans travel to"
            title={travel.title}
            titleAs="h2"
            stacked
            onSource={source(travel.receipt)}
            table={travel.rows.length > 0 ? <TravelTable rows={travel.rows} label={travel.title} /> : undefined}
            caption={travel.rows.length > 0 ? caption("Places their fans are drawn to, not where they live.", travel.gap) : undefined}
          >
            {travel.rows.length > 0 ? <TravelBars rows={travel.rows} label={travel.title} /> : <Empty gap={travel.gap} />}
          </ChartCard>
        </div>
      </div>

      <MarginRail profile={profile} onSources={() => setHow({ tab: "sources", receipt: null })} />

      <ProfileDrawer how={profile.how} target={how} onTarget={setHow} onClose={() => setHow(null)} onCopied={() => show("Copied")} />
      {toast}
    </div>
  );
}
