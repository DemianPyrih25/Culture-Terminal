import { cx } from "../../components/ui/cx";
import { BODY, LABEL, RefNote, RefSection, ROW, SUBHEAD } from "../../components/method/reference";
import type { CoverageFacts } from "./coverage";

/**
 * The coverage card on /method: every place type and sponsor category with the live probe gate that
 * verified it, or the named fallback that runs instead (PLAN §11.2), plus the Part 8 named lists and
 * gender contexts. The facts come from the configs the skills read (coverage.ts).
 */

export const COVERAGE_SECTION_ID = "coverage";

export const COVERAGE_COPY = {
  title: "Coverage",
  aside: (places: number, sponsors: number) => `${places} place types · ${sponsors} sponsor categories`,
  intro:
    "A place type or sponsor category is used only the way a live probe verified it. The gate names the check: G for the " +
    "gating probe, P5 for the Part 5 probe, C1 and C2 for the coverage probe. Where no tag passed, the named fallback runs " +
    "instead and the note says so.",
  placesHeading: "Place types (find_tags, geo_lift)",
  placesCaption: "Each place type's verified heatmap signal and venue filter",
  signal: "Heatmap signal",
  filter: "Venue filter",
  noFilter: "Not verified: no venue sample is drawn, so the competitor count is unknown",
  filterSearched: "Not verified: a tag found at run time counts no venues, so the competitor count is unknown",
  sponsorsHeading: "Sponsor categories (sponsor_slate)",
  sponsorsCaption: "Each sponsor category's verified brand filter, or its fallback",
  gate: "Brand filter",
  searched: "Fallback: found by semantic tag search at run time, labelled in the note",
  unverified: "Not verified",
  otherHeading: "Lists and contexts",
  other: [
    { term: "Named lists", text: "Podcasts, TV shows and movies are scored on one scale over an exact list (C3), from seeds or by age; TV shows also by audience (C5)." },
    { term: "Gender", text: "Male and female audience contexts rank and share brands and persons (C4). Qloo's gender signal is binary." },
    { term: "Audiences", text: "Segments of the six allowed families are read from Qloo, pinned and offered to the analyst; code refuses any other (C5, D21)." },
  ],
  note: "A gate is the probe check that passed live; the probe's raw answers stay out of the repository.",
  trace: "config/categories.json · config/sponsor_categories.json · packages/qloo/src/allowlist.ts",
} as const;

const TABLE = "w-full border-collapse";
const gateText = (gate: string | null, none: string): string => (gate === null ? none : `Verified ${gate}`);

export function CoverageSection({ facts }: { facts: CoverageFacts }) {
  return (
    <RefSection
      id={COVERAGE_SECTION_ID}
      title={COVERAGE_COPY.title}
      aside={COVERAGE_COPY.aside(facts.placeTypes.length, facts.sponsors.length)}
      note={<RefNote trace={COVERAGE_COPY.trace}>{COVERAGE_COPY.note}</RefNote>}
    >
      <p className={BODY}>{COVERAGE_COPY.intro}</p>
      <div className="flex flex-col gap-2">
        <h3 className={SUBHEAD}>{COVERAGE_COPY.placesHeading}</h3>
        <table className={TABLE} data-coverage="places">
          <caption className="sr-only">{COVERAGE_COPY.placesCaption}</caption>
          <thead>
            <tr className="h-8">
              <th scope="col" className="text-left">
                <span className="sr-only">Place type</span>
              </th>
              <th scope="col" className={cx(LABEL, "w-[30%] text-left font-semibold")}>
                {COVERAGE_COPY.signal}
              </th>
              <th scope="col" className={cx(LABEL, "w-[34%] text-left font-semibold")}>
                {COVERAGE_COPY.filter}
              </th>
            </tr>
          </thead>
          <tbody>
            {facts.placeTypes.map((p) => (
              <tr key={p.key} className={ROW} data-place={p.key}>
                <th scope="row" className="py-2 pr-3 text-left type-body font-normal text-ink">
                  {p.label}
                </th>
                <td className={cx(BODY, "py-2 pr-3")}>{gateText(p.signal, COVERAGE_COPY.unverified)}</td>
                <td className={cx(BODY, "py-2")}>{gateText(p.filter, p.filterSearched ? COVERAGE_COPY.filterSearched : COVERAGE_COPY.noFilter)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className={SUBHEAD}>{COVERAGE_COPY.sponsorsHeading}</h3>
        <table className={TABLE} data-coverage="sponsors">
          <caption className="sr-only">{COVERAGE_COPY.sponsorsCaption}</caption>
          <tbody>
            {facts.sponsors.map((s) => (
              <tr key={s.key} className={ROW} data-sponsor={s.key}>
                <th scope="row" className="w-[42%] py-2 pr-3 text-left type-body font-normal text-ink">
                  {s.label}
                </th>
                <td className={cx(BODY, "py-2")}>
                  {s.gate !== null ? `${COVERAGE_COPY.gate}: verified ${s.gate}` : s.searched ? COVERAGE_COPY.searched : COVERAGE_COPY.unverified}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className={SUBHEAD}>{COVERAGE_COPY.otherHeading}</h3>
        <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[120px_minmax(0,1fr)]">
          {COVERAGE_COPY.other.map((row) => (
            <div key={row.term} className="contents">
              <dt className="type-body-strong text-ink">{row.term}</dt>
              <dd className={cx(BODY, "max-sm:pb-1")}>{row.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    </RefSection>
  );
}
