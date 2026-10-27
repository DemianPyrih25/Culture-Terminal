import { type Pillar, SafetyCategory } from "@ct/contracts";
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
  TRUST_SECTION_ORDER,
  TRUST_SECTIONS,
  type TrustSectionId,
} from "../../content/trust";
import { SAFETY_LABEL } from "../../lib/brief/format";
import { topicForPillar } from "../ui/topic";
import { cx } from "../ui/cx";
import { Tag } from "../ui/tag";
import { BODY, LABEL, LIST, RefNote, RefSection, ROW, SUBHEAD, TermList } from "./reference";

/**
 * The rules /method states (moved from /trust): safe use and what enforces each rule, the clerk's
 * refusal categories with the reframe offered, the audience allowlist per desk (from @ct/qloo, passed
 * in by the page), data handling, and the models and cost guards (the server's lane budgets).
 */

export interface AudienceAllowlistView {
  desks: Readonly<Record<Pillar, readonly string[]>>;
  denied: { families: readonly string[]; audiences: readonly string[] };
}

export interface RulesFacts {
  /** AUDIENCE_ALLOWLIST from @ct/qloo, as plain data. */
  allowlist: AudienceAllowlistView;
  /** Model names as words: "Haiku 5.5". */
  models: { clerk: string; analyst: string; economy: string };
  /** The per-answer limits (DEFAULT_RUN_LIMITS). */
  limits: Parameters<typeof perBriefGuards>[0];
  /** The server's daily budgets. */
  daily: Parameters<typeof dailyGuards>[0];
}

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

export const RULES_INDEX: readonly { id: TrustSectionId; label: string }[] = TRUST_SECTION_ORDER.map((id) => ({ id, label: TRUST_SECTIONS[id].title }));

/** "Kit · agent prompts" or "Ours". */
function sourceLabel(r: SafeUseRule): string {
  const label = SAFE_USE_SOURCE_LABEL[r.source];
  return r.source === "kit" && r.basis ? `${label} · ${r.basis}` : label;
}

function SafeUse() {
  return (
    <RefSection id="safe-use" title={TRUST_SECTIONS["safe-use"].title} aside={TRUST_SECTIONS["safe-use"].aside}>
      <p className={BODY}>{SAFE_USE_INTRO}</p>
      <ol className={LIST}>
        {SAFE_USE.map((r) => (
          <li key={r.id} className={cx(ROW, "grid gap-x-6 gap-y-1 py-3 sm:grid-cols-[220px_minmax(0,1fr)]")} data-safe-use={r.id} data-source={r.source}>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="type-body-strong text-ink">{r.rule}</span>
              <span className={LABEL}>{sourceLabel(r)}</span>
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className={BODY}>{r.enforced}</span>
              <span className="font-mono text-[12px] leading-[18px] text-ink-2">{r.where}</span>
            </span>
          </li>
        ))}
      </ol>
    </RefSection>
  );
}

function Refusals() {
  // The clerk's precedence first; a category added to the contract later still shows, at the end.
  const order = [...REFUSAL_ORDER, ...SafetyCategory.options.filter((c) => !REFUSAL_ORDER.includes(c))];
  return (
    <RefSection
      id="refusals"
      title={TRUST_SECTIONS.refusals.title}
      aside={TRUST_SECTIONS.refusals.aside}
      note={<RefNote trace={REFUSALS_NOTE.trace}>{REFUSALS_NOTE.text}</RefNote>}
    >
      <p className={BODY}>{REFUSALS_INTRO}</p>
      <ol className={LIST}>
        {order.map((category) => {
          const r = REFUSALS[category];
          return (
            <li key={category} id={`refusal-${category}`} className={cx(ROW, "flex flex-col gap-1.5 py-3")} data-refusal={category}>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="type-body-strong text-ink">{SAFETY_LABEL[category]}</span>
                <Tag tone={r.outcome === "refused" ? "danger" : "accent"}>{OUTCOME_LABEL[r.outcome]}</Tag>
              </p>
              <p className={BODY}>{r.covers}</p>
              <p className={BODY}>
                <span className="font-medium text-ink">{REFUSAL_LABELS.reframe}: </span>
                {r.reframe ?? REFUSAL_LABELS.noReframe}
              </p>
            </li>
          );
        })}
      </ol>
    </RefSection>
  );
}

function Allowlist({ allowlist }: { allowlist: AudienceAllowlistView }) {
  return (
    <RefSection
      id="allowlist"
      title={TRUST_SECTIONS.allowlist.title}
      aside={TRUST_SECTIONS.allowlist.aside}
      note={<RefNote trace={ALLOWLIST_COPY.noteTrace}>{ALLOWLIST_COPY.note}</RefNote>}
    >
      <p className={BODY}>{ALLOWLIST_COPY.intro}</p>
      <div className="flex flex-col gap-1">
        <h3 className={SUBHEAD}>{ALLOWLIST_COPY.desksHeading}</h3>
        <table className="w-full border-collapse" data-allowlist="desks">
          <caption className="sr-only">{ALLOWLIST_COPY.desksCaption}</caption>
          <tbody>
            {(Object.keys(allowlist.desks) as Pillar[]).map((pillar) => (
              <tr key={pillar} className={ROW} data-desk={pillar}>
                <th scope="row" className="w-[168px] py-3 pr-4 text-left type-body-strong text-ink max-sm:w-[112px]">
                  {topicForPillar(pillar).label}
                </th>
                <td className="py-3">
                  <ul className="flex flex-wrap gap-x-1 type-body text-ink">
                    {allowlist.desks[pillar].map((family, i, all) => (
                      <li key={family} data-family={family}>
                        {familyLabel(family)}
                        {i < all.length - 1 ? <span className="text-ink-3"> ·</span> : null}
                      </li>
                    ))}
                  </ul>
                  <span className={cx(LABEL, "block")}>{DESK_ALLOWLIST_REASON[pillar]}</span>
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
            <li key={family} className={cx(ROW, "grid gap-x-4 py-3 sm:grid-cols-[220px_minmax(0,1fr)]")} data-denied-family={family}>
              <span className="type-body-strong text-danger-ink">{familyLabel(family)}</span>
              <span className={BODY}>{DENIED_FAMILY_REASON[family] ?? ALLOWLIST_COPY.noReason}</span>
            </li>
          ))}
        </ul>
        {allowlist.denied.audiences.length > 0 ? (
          <p className={cx(BODY, "pt-2")}>
            <span className="font-medium text-ink">{ALLOWLIST_COPY.deniedAudiences}: </span>
            {allowlist.denied.audiences.map((urn, i) => (
              <span key={urn} data-denied-audience={urn}>
                {i > 0 ? " · " : null}
                {audienceLabel(urn)}
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </RefSection>
  );
}

function Data() {
  return (
    <RefSection id="data" title={TRUST_SECTIONS.data.title} aside={TRUST_SECTIONS.data.aside} note={<RefNote trace={DATA_NOTE.trace}>{DATA_NOTE.text}</RefNote>}>
      <TermList rows={DATA_HANDLING} />
    </RefSection>
  );
}

function Guards({ models, limits, daily }: Pick<RulesFacts, "models" | "limits" | "daily">) {
  const roles: { role: string; model: string }[] = [
    { role: GUARDS_COPY.roles.clerk, model: models.clerk },
    { role: GUARDS_COPY.roles.analyst, model: models.analyst },
    { role: GUARDS_COPY.roles.economy, model: models.economy },
    { role: GUARDS_COPY.roles.quant, model: GUARDS_COPY.code },
    { role: GUARDS_COPY.roles.checker, model: GUARDS_COPY.code },
  ];
  return (
    <RefSection
      id="guards"
      title={TRUST_SECTIONS.guards.title}
      aside={TRUST_SECTIONS.guards.aside}
      note={<RefNote trace={GUARDS_COPY.noteTrace}>{GUARDS_COPY.note}</RefNote>}
    >
      <div className="flex flex-col gap-1">
        <h3 className={SUBHEAD}>{GUARDS_COPY.modelsHeading}</h3>
        <table className="w-full border-collapse" data-models="true">
          <caption className="sr-only">{GUARDS_COPY.modelsCaption}</caption>
          <tbody>
            {roles.map((r) => (
              <tr key={r.role} className={ROW}>
                <th scope="row" className={cx(BODY, "py-2 pr-4 text-left font-normal")}>
                  {r.role}
                </th>
                <td className="py-2 text-right type-body-strong whitespace-nowrap text-ink">{r.model}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-3">
        <h3 className={SUBHEAD}>{GUARDS_COPY.perBriefHeading}</h3>
        <TermList rows={perBriefGuards(limits)} />
      </div>
      <div className="flex flex-col gap-3">
        <h3 className={SUBHEAD}>{GUARDS_COPY.dailyHeading}</h3>
        <TermList rows={dailyGuards(daily, models)} />
      </div>
    </RefSection>
  );
}

/** The five rules sections, in order. */
export function RulesSections({ allowlist, models, limits, daily }: RulesFacts) {
  return (
    <>
      <SafeUse />
      <Refusals />
      <Allowlist allowlist={allowlist} />
      <Data />
      <Guards models={models} limits={limits} daily={daily} />
    </>
  );
}
