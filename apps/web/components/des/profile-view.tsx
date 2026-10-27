"use client";

import { useState, type ReactNode } from "react";
import { Button, ButtonLink } from "../ui/button";
import { ChartCard } from "../ui/chart-card";
import { Hatch } from "../ui/skeleton";
import { KeyNumber } from "../ui/key-number";
import { Monogram } from "../ui/monogram";
import { useToast } from "../ui/toast";
import { LookUpAnother } from "./look-up";
import { ProfileDrawer, type HowTarget } from "./profile-drawer";
import type { ProfileModel } from "./profile-model";
import {
  DivergingRows,
  FansTable,
  NeighbourColumns,
  NeighboursTable,
  TagGroups,
  TravelBars,
  TravelTable,
} from "./profile-plots";

/**
 * The audience profile (N14 QrdGr): the entity header, three key numbers, who the fans are and how Qloo
 * describes the name, what else their fans love, and the places their fans travel to. Every Source opens
 * How we know on the request behind it.
 */

function EntityHeader({ profile, onHow }: { profile: ProfileModel; onHow: () => void }) {
  return (
    <header className="flex flex-col gap-[18px]" data-entity-header="true">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 items-center gap-4">
          <Monogram name={profile.name} size={56} palette="subject" className="max-md:hidden" />
          <Monogram name={profile.name} size={48} palette="subject" className="md:hidden" />
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="type-display-m break-words text-ink max-md:type-display-m-sm">{profile.name}</h1>
            <p className="type-label text-ink-2" data-label-line="true">
              {profile.labelLine}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 max-md:w-full">
          <ButtonLink href={profile.askHref} prefetch={false} variant="primary" className="max-md:w-full max-md:justify-center">
            Ask about {profile.name}
          </ButtonLink>
          <LookUpAnother type={profile.type} />
          <Button variant="quiet" icon="shield-check" onClick={onHow}>
            How we know
          </Button>
        </div>
      </div>
      <p className="type-lead text-ink-2 max-md:text-[16px] max-md:leading-6">
        Who its fans are, what else they love, and where their taste travels.
        {profile.lookedUpAs ? <span className="block type-label">Looked up as “{profile.lookedUpAs}”.</span> : null}
      </p>
    </header>
  );
}

/** A card body when a part has no data: the hatch and why. */
function Empty({ gap }: { gap: string | null }) {
  return (
    <div className="flex flex-col gap-3">
      <Hatch className="min-h-24" />
      {gap ? <p className="type-label text-ink-2">{gap}</p> : null}
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
    <div className="flex flex-col gap-9 pt-10 pb-12 max-md:gap-6 max-md:pt-6 max-md:pb-8" data-profile="true">
      <EntityHeader profile={profile} onHow={() => setHow({ tab: "summary", receipt: null })} />

      <div className="flex flex-col gap-6 max-md:gap-4">
        <section aria-label="Key numbers" className="grid grid-cols-3 gap-6 max-md:grid-cols-1 max-md:gap-4">
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
          caption={neighbours.columns.length > 0 ? caption("Ranked by how much more these fans like them than average.", neighbours.gap) : undefined}
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

      <ProfileDrawer how={profile.how} target={how} onTarget={setHow} onClose={() => setHow(null)} onCopied={() => show("Copied")} />
      {toast}
    </div>
  );
}
