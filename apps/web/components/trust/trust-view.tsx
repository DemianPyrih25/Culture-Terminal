import { type Pillar, SafetyCategory } from "@ct/contracts";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  ALLOWLIST_COPY,
  DATA_HANDLING,
  DATA_NOTE,
  dailyGuards,
  DENIED_FAMILY_REASON,
  DESK_ALLOWLIST_REASON,
  FAMILY_LABEL,
  GUARDS_COPY,
  OUTCOME_LABEL,
  perBriefGuards,
  REFUSAL_LABELS,
  REFUSAL_ORDER,
  REFUSALS,
  REFUSALS_INTRO,
  REFUSALS_NOTE,
  SAFE_USE,
  SAFE_USE_INTRO,
  SAFE_USE_SOURCE_LABEL,
  type SafeUseRule,
  TRUST_PAGE,
  TRUST_SECTION_ORDER,
  TRUST_SECTIONS,
  TRUST_SOURCES,
  type TrustSectionId,
} from "../../content/trust";
import { DESK_LABEL, SAFETY_LABEL } from "../../lib/brief/format";
import { BriefRow } from "../layout/brief-row";
import { Outline } from "../layout/outline";
import {
  Colophon,
  NoteRef,
  REFERENCE_STICKY_TOP,
  ReferenceGrid,
  ReferenceHead,
  SECTION_CLASS,
  SideNote,
  SMALL_CAPS,
  TraceNote,
} from "../method/reference";
import { cx } from "../ui/cx";
import { SectionHead } from "../ui/section-head";

/**
 * /trust: the safe-use rules, the kit's guidance and ours, and what enforces each (SPEC §6.5), the
 * CLERK's refusal categories with an example and the reframe offered, the audience allowlist per desk
 * (from @ct/qloo, passed in by the page), data handling, and the model and cost guards (the server's
 * lane budgets). Copy lives in content/trust.ts.
 */

export interface AudienceAllowlistView {
  desks: Readonly<Record<Pillar, readonly string[]>>;
  denied: { families: readonly string[]; audiences: readonly string[] };
}

export interface TrustViewProps {
  /** AUDIENCE_ALLOWLIST from @ct/qloo, as plain data. */
  allowlist: AudienceAllowlistView;
  /** Model names as words: "Haiku 5.5". */
  models: { clerk: string; analyst: string; economy: string };
  /** The per-brief limits (DEFAULT_RUN_LIMITS). */
  limits: Parameters<typeof perBriefGuards>[0];
  /** The server's daily budgets. */
  daily: Parameters<typeof dailyGuards>[0];
}

const BODY = "m-0 text-[13px] leading-5 text-text-2";
const SUBHEAD = "m-0 text-[11px] leading-[14px] font-semibold tracking-[1.3px] text-dim uppercase";
const LIST = "m-0 flex list-none flex-col p-0";

/** "hobbies_and_interests" → "Hobbies and interests", or the name FAMILY_LABEL gives it. */
export function familyLabel(family: string): string {
  const named = FAMILY_LABEL[family];
  if (named) return named;
  const words = family.split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "urn:audience:leisure:political_junkie" → "Political junkie (leisure)". */
export function audienceLabel(urn: string): string {
  const parts = urn.split(":");
  const leaf = parts.at(-1) ?? urn;
  const family = parts.length > 3 ? parts[2] : null;
  return family ? `${familyLabel(leaf)} (${family.split("_").join(" ")})` : familyLabel(leaf);
}

/** Note numbers in reading order. */
const NOTE = { refusals: 1, allowlist: 2, data: 3, guards: 4 } as const;

function Section({ id, n, children }: { id: TrustSectionId; n: number; children: ReactNode }) {
  const s = TRUST_SECTIONS[id];
  return (
    <section id={id} className={SECTION_CLASS} data-section={id}>
      <SectionHead number={n} title={s.title} aside={s.aside} />
      {children}
    </section>
  );
}

/** "Kit · agent prompts" or "Ours". */
function sourceLabel(r: SafeUseRule): string {
  const label = SAFE_USE_SOURCE_LABEL[r.source];
  return r.source === "kit" && r.basis ? `${label} · ${r.basis}` : label;
}

function SafeUse() {
  return (
    <div className="flex flex-col gap-3">
      <p className={BODY}>{SAFE_USE_INTRO}</p>
      <ol className={LIST}>
        {SAFE_USE.map((r) => (
          <li
            key={r.id}
            className="grid gap-x-5 gap-y-1 border-t border-line py-2.5 sm:grid-cols-[200px_minmax(0,1fr)]"
            data-safe-use={r.id}
            data-source={r.source}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] leading-5 font-medium text-ink">{r.rule}</span>
              <span className={cx(SMALL_CAPS, "text-dim")}>{sourceLabel(r)}</span>
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className={BODY}>{r.enforced}</span>
              <span className="type-trace text-faint">{r.where}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Refusals() {
  // The clerk's precedence first; a category added to the contract later still shows, at the end.
  const order = [...REFUSAL_ORDER, ...SafetyCategory.options.filter((c) => !REFUSAL_ORDER.includes(c))];
  return (
    <div className="flex flex-col gap-3">
      <p className={BODY}>
        {REFUSALS_INTRO}
        <NoteRef n={NOTE.refusals} />
      </p>
      <ol className={LIST}>
        {order.map((category) => {
          const r = REFUSALS[category];
          return (
            <li key={category} id={`refusal-${category}`} className="flex flex-col gap-1.5 border-t border-line py-3" data-refusal={category}>
              <p className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="text-[13px] leading-5 font-medium text-ink">{SAFETY_LABEL[category]}</span>
                <span className={cx(SMALL_CAPS, r.outcome === "refused" ? "text-negative" : "text-accent")}>{OUTCOME_LABEL[r.outcome]}</span>
                <span className="font-mono text-[10.5px] text-faint sm:ml-auto">{category}</span>
              </p>
              <p className={BODY}>{r.covers}</p>
              <dl className="m-0 grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px] leading-5">
                <dt className={cx(SMALL_CAPS, "pt-[3px] text-dim")}>{REFUSAL_LABELS.example}</dt>
                <dd className="m-0 font-serif text-[15px] leading-[21px] text-ink italic">“{r.example}”</dd>
                <dt className={cx(SMALL_CAPS, "pt-[3px] text-dim")}>{REFUSAL_LABELS.reframe}</dt>
                <dd className="m-0 text-text-2">{r.reframe ?? REFUSAL_LABELS.noReframe}</dd>
              </dl>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Allowlist({ allowlist }: { allowlist: AudienceAllowlistView }) {
  return (
    <div className="flex flex-col gap-4">
      <p className={BODY}>
        {ALLOWLIST_COPY.intro}
        <NoteRef n={NOTE.allowlist} />
      </p>
      <div className="flex flex-col gap-1">
        <h3 className={SUBHEAD}>{ALLOWLIST_COPY.desksHeading}</h3>
        <table className="w-full border-collapse text-[13px] leading-5" data-allowlist="desks">
          <caption className="sr-only">{ALLOWLIST_COPY.desksCaption}</caption>
          <tbody>
            {(Object.keys(allowlist.desks) as Pillar[]).map((pillar) => (
              <tr key={pillar} className="border-t border-line align-baseline" data-desk={pillar}>
                <th scope="row" className="w-[112px] py-2 pr-3 text-left text-[11px] font-semibold tracking-[1.3px] text-accent uppercase">
                  {DESK_LABEL[pillar]}
                </th>
                <td className="py-2">
                  <ul className="m-0 flex list-none flex-wrap gap-x-1 p-0 text-ink">
                    {allowlist.desks[pillar].map((family, i, all) => (
                      <li key={family} data-family={family}>
                        {familyLabel(family)}
                        {i < all.length - 1 ? <span className="text-faint"> ·</span> : null}
                      </li>
                    ))}
                  </ul>
                  <span className="block text-[12px] leading-[17px] text-dim">{DESK_ALLOWLIST_REASON[pillar]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-1">
        <h3 className={SUBHEAD}>{ALLOWLIST_COPY.deniedHeading}</h3>
        <ul className={LIST} data-allowlist="denied">
          {allowlist.denied.families.map((family) => (
            <li key={family} className="grid gap-x-3 border-t border-line py-2 sm:grid-cols-[200px_minmax(0,1fr)]" data-denied-family={family}>
              <span className="flex flex-col">
                <span className="text-[13px] leading-5 font-medium text-negative">{familyLabel(family)}</span>
                <span className="font-mono text-[10.5px] leading-[15px] text-faint">{family}</span>
              </span>
              <span className={BODY}>{DENIED_FAMILY_REASON[family] ?? ALLOWLIST_COPY.noReason}</span>
            </li>
          ))}
        </ul>
        {allowlist.denied.audiences.length > 0 ? (
          <p className="m-0 flex flex-wrap gap-x-2 pt-1 text-[13px] leading-5 text-text-2">
            <span className={cx(SMALL_CAPS, "pt-[3px] text-dim")}>{ALLOWLIST_COPY.deniedAudiences}</span>
            {allowlist.denied.audiences.map((urn) => (
              <span key={urn} data-denied-audience={urn}>
                {audienceLabel(urn)} <span className="font-mono text-[10.5px] text-faint">{urn}</span>
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Term and text rows; `note` puts a sidenote ref after one row's text. */
function TermList({ rows, note }: { rows: readonly { term: string; text: string }[]; note?: { term: string; n: number } }) {
  return (
    <dl className="m-0 grid gap-x-3 gap-y-2 text-[13px] leading-5 sm:grid-cols-[136px_minmax(0,1fr)]">
      {rows.map((r) => (
        <div key={r.term} className="contents">
          <dt className="font-medium text-ink">{r.term}</dt>
          <dd className="m-0 text-text-2 max-sm:pb-1">
            {r.text}
            {note?.term === r.term ? <NoteRef n={note.n} /> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function DataHandling() {
  return <TermList rows={DATA_HANDLING} note={{ term: DATA_NOTE.term, n: NOTE.data }} />;
}

function Guards({ models, limits, daily }: Pick<TrustViewProps, "models" | "limits" | "daily">) {
  const roles: { role: string; model: string }[] = [
    { role: GUARDS_COPY.roles.clerk, model: models.clerk },
    { role: GUARDS_COPY.roles.analyst, model: models.analyst },
    { role: GUARDS_COPY.roles.economy, model: models.economy },
    { role: GUARDS_COPY.roles.quant, model: GUARDS_COPY.code },
    { role: GUARDS_COPY.roles.checker, model: GUARDS_COPY.code },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className={SUBHEAD}>{GUARDS_COPY.modelsHeading}</h3>
        <table className="w-full border-collapse text-[13px] leading-5" data-models="true">
          <caption className="sr-only">{GUARDS_COPY.modelsCaption}</caption>
          <tbody>
            {roles.map((r) => (
              <tr key={r.role} className="border-t border-line align-baseline">
                <th scope="row" className="py-1.5 pr-3 text-left font-normal text-text-2">
                  {r.role}
                </th>
                <td className="py-1.5 text-right font-medium whitespace-nowrap text-ink">{r.model}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className={SUBHEAD}>{GUARDS_COPY.perBriefHeading}</h3>
        <TermList rows={perBriefGuards(limits)} />
      </div>
      <div className="flex flex-col gap-2">
        <h3 className={SUBHEAD}>
          {GUARDS_COPY.dailyHeading}
          <NoteRef n={NOTE.guards} />
        </h3>
        <TermList rows={dailyGuards(daily, models)} />
      </div>
    </div>
  );
}

export function TrustView({ allowlist, models, limits, daily }: TrustViewProps) {
  const categories = SafetyCategory.options.length;
  const outline = (
    <Outline
      heading={TRUST_PAGE.outlineHeading}
      spyOffset={REFERENCE_STICKY_TOP + 24}
      items={TRUST_SECTION_ORDER.map((id) => ({
        id,
        label: TRUST_SECTIONS[id].title,
        ...(id === "refusals" ? { count: categories } : id === "safe-use" ? { count: SAFE_USE.length } : {}),
      }))}
      meta={{
        trace: TRUST_PAGE.outlineTrace,
        text: (
          <Link href="/method" className="text-accent hover:underline">
            {TRUST_PAGE.methodLink}
          </Link>
        ),
      }}
    />
  );
  return (
    <ReferenceGrid outline={outline}>
      <BriefRow
        notes={
          <div className="flex flex-col gap-6">
            <TraceNote head={TRUST_SOURCES.traceHead(SAFE_USE.length, categories)} detail={TRUST_SOURCES.traceDetail} />
            <Colophon heading={TRUST_SOURCES.heading} rows={TRUST_SOURCES.rows(models.clerk)} />
          </div>
        }
      >
        <div className="flex flex-col gap-[22px]">
          <ReferenceHead
            kicker={TRUST_PAGE.kicker}
            section={TRUST_PAGE.section}
            extra={TRUST_PAGE.extra}
            title={TRUST_PAGE.title}
            lede={TRUST_PAGE.lede}
          />
          <Section id="safe-use" n={1}>
            <SafeUse />
          </Section>
        </div>
      </BriefRow>
      <BriefRow notes={<SideNote n={NOTE.refusals} text={REFUSALS_NOTE.text} trace={REFUSALS_NOTE.trace} />}>
        <Section id="refusals" n={2}>
          <Refusals />
        </Section>
      </BriefRow>
      <BriefRow notes={<SideNote n={NOTE.allowlist} text={ALLOWLIST_COPY.note} trace={ALLOWLIST_COPY.noteTrace} />}>
        <Section id="allowlist" n={3}>
          <Allowlist allowlist={allowlist} />
        </Section>
      </BriefRow>
      <BriefRow notes={<SideNote n={NOTE.data} text={DATA_NOTE.text} trace={DATA_NOTE.trace} />}>
        <Section id="data" n={4}>
          <DataHandling />
        </Section>
      </BriefRow>
      <BriefRow notes={<SideNote n={NOTE.guards} text={GUARDS_COPY.note} trace={GUARDS_COPY.noteTrace} />}>
        <Section id="guards" n={5}>
          <Guards models={models} limits={limits} daily={daily} />
        </Section>
      </BriefRow>
    </ReferenceGrid>
  );
}
