import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { formatUtcDateTime, formatUtcTime, plural } from "../../lib/brief/format";
import { Exhibit, FigureFrame, type ExhibitDisplay, type FigureSource } from "../figures";
import { BriefRow } from "../layout/brief-row";
import { Outline } from "../layout/outline";
import { NoteRef, REFERENCE_STICKY_TOP, ReferenceGrid, SECTION_CLASS, SideNote, TraceNote } from "../method/reference";
import { cx } from "../ui/cx";
import { MetaLine } from "../ui/meta-line";
import { MiniMeter } from "../ui/mini-meter";
import { SectionHead } from "../ui/section-head";
import { DES_TYPE_LABEL, desHref, type DesType } from "./des-href";
import { DesSearch } from "./des-search";
import styles from "./des.module.css";
import type { DesCandidate, DesFigure, DesKeyFigure, DesOutcome, DesSection, DesSectionId, Tearsheet } from "./model";
import { Receipts, receiptId } from "./receipts";

/**
 * The DES tearsheet (P1 #1; Concept A, D36): one page on one entity, answer first and mechanics last.
 * The name, its type and Qloo's description; four key figures; Audience DNA; the cultural
 * neighbourhood in music, podcasts, TV and brands; travel taste; then Receipts, every request with its
 * stamp. Server components only: the figures' table toggles and the outline are the client parts.
 */

const BODY = "m-0 text-[13px] leading-5 text-text-2";
const KICKER = "m-0 text-[11px] leading-4 font-semibold tracking-[1.3px] uppercase";
const FULL_WIDTH = 680;
const HALF_WIDTH = 328;
/** Below this a full-width plot scrolls sideways instead of shrinking its labels. */
const MIN_FULL_PLOT = 520;
/**
 * Travel fit is a within-call percentile, so the top destination sits on 1.00, the plot's top edge,
 * where no label fits beside it. Headroom above 1 and a taller plot give its label room when its
 * neighbours allow; the ticks still end at 1.
 */
const QUADRANT_Y_HEADROOM = 0.15;
const QUADRANT_PLOT_HEIGHT = 176;

const SECTION_ORDER: readonly { id: "overview" | DesSectionId | "receipts"; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "dna", label: "Audience DNA" },
  { id: "neighbours", label: "Cultural neighbours" },
  { id: "travel", label: "Travel taste" },
  { id: "receipts", label: "Receipts" },
];

/** Short enough to sit beside the section's name on a phone. */
const SECTION_ASIDE: Readonly<Record<DesSectionId, string>> = {
  dna: "Group-level",
  neighbours: "What else they love",
  travel: "Not residence",
};

/** What each section is, in one line, before its figures. */
const SECTION_LEDE: Readonly<Record<DesSectionId, string>> = {
  dna: "Age and gender affinity of the audience against the average audience, and the tags Qloo files the entity under.",
  neighbours: "The top names in each domain that this audience's taste points to, ranked by fit within each request.",
  travel: "US destinations this audience's taste points to, placed by fit and by popularity.",
};

// The page head --------------------------------------------------------------------------------------

function Head({ kicker, extra, title, lede }: { kicker: string; extra: readonly ReactNode[]; title: string; lede: ReactNode }) {
  return (
    <header className="flex flex-col gap-[22px]">
      <MetaLine desk="DES" job={kicker} extra={extra} />
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-serif text-[32px] leading-[38px] font-medium tracking-[-0.4px] break-words text-ink md:text-[40px] md:leading-[48px]">
          {title}
        </h1>
        <p className="m-0 font-serif text-[18px] leading-[27px] text-text-2">{lede}</p>
      </div>
    </header>
  );
}

function Section({ id, n, title, aside, children }: { id: string; n: number; title: string; aside?: string; children: ReactNode }) {
  return (
    <section id={id} className={SECTION_CLASS} data-section={id}>
      <SectionHead number={n} title={title} aside={aside} />
      {children}
    </section>
  );
}

// Key figures ----------------------------------------------------------------------------------------

function KeyFigures({ figures }: { figures: readonly DesKeyFigure[] }) {
  if (figures.length === 0) return <p className={BODY}>Qloo returned no figure to headline for this entity.</p>;
  return (
    <div className="grid w-full grid-cols-2 gap-y-5 sm:flex sm:flex-wrap" data-key-figures={figures.length}>
      {figures.map((f, i) => (
        <div
          key={f.key}
          className={cx(
            "flex min-w-0 flex-col gap-1.5 py-0.5 sm:min-w-[132px] sm:flex-1 sm:border-l sm:border-line sm:px-4 sm:first:border-l-0 sm:first:pl-0",
            i % 2 === 1 ? "border-l border-line pl-4 sm:pl-4" : "pr-3",
          )}
          data-key-figure={f.key}
          data-badge={f.badge}
        >
          <span className="flex items-start gap-0.5">
            <span
              className={cx(
                f.badge === "UNAVAILABLE"
                  ? "font-serif text-[20px] leading-[37px] font-medium text-dim"
                  : f.kind === "name"
                    ? "pt-1.5 font-serif text-[22px] leading-[28px] font-medium text-ink"
                    : "type-key-figure text-ink",
                "min-w-0 break-words",
              )}
            >
              {f.value}
            </span>
            {f.receipt !== null ? (
              <a
                href={`#${receiptId(f.receipt)}`}
                className="text-[11px] leading-4 font-semibold text-accent hover:underline"
                aria-label={`${f.label}: request ${f.receipt} in Receipts`}
              >
                {f.receipt}
              </a>
            ) : null}
          </span>
          <p className="m-0 text-[13px] leading-[18px] text-text-2">{f.label}</p>
          <p className="m-0 text-[10px] leading-[14px] font-semibold tracking-[0.8px] text-dim uppercase">{f.detail}</p>
        </div>
      ))}
    </div>
  );
}

// Figures --------------------------------------------------------------------------------------------

function sourceOf(figure: DesFigure): FigureSource {
  return {
    text: figure.source.text,
    requestId: figure.source.requestId,
    href: figure.source.receipt !== null ? `#${receiptId(figure.source.receipt)}` : null,
  };
}

/** The display a family gets on a tearsheet: one series of DNA bars, one list per domain. */
function displayOf(figure: DesFigure, width: number): ExhibitDisplay {
  switch (figure.dataset.kind) {
    case "Ranked":
      return { Ranked: { variant: "lists", width } };
    case "Bars":
      return { Bars: { width } };
    case "Quadrant": {
      const { points, ySplit } = figure.dataset.payload;
      const featured = figure.featured ?? [];
      // The point the title names is the only ring, so the caption can point to it; the payload's
      // labelled points keep their labels.
      const labelled = points.filter((p) => p.labelled).map((p) => p.key);
      const percentile = [...points.map((p) => p.y), ySplit].every((y) => y >= 0 && y <= 1);
      return {
        Quadrant: {
          width,
          plotHeight: QUADRANT_PLOT_HEIGHT,
          ...(featured.length > 0 ? { featuredKeys: featured, highlightKeys: [...new Set([...featured, ...labelled])] } : {}),
          ...(percentile ? { yDomain: { min: 0, max: 1 + QUADRANT_Y_HEADROOM } } : {}),
        },
      };
    }
    default:
      return {};
  }
}

/** Facet tags as chips by family, in the A/Figure frame: its peer column counts nothing for a lone entity. */
function TagsFigure({ figure, number }: { figure: DesFigure; number: number }) {
  if (figure.dataset.kind !== "Ranked") return null;
  const groups = figure.dataset.payload.groups.filter((g) => g.rows.length > 0);
  const plot = (
    <dl className="m-0 flex flex-col gap-2 pt-3 pb-1">
      {groups.map((g) => (
        <div key={g.key} className="grid gap-x-4 gap-y-1 sm:grid-cols-[132px_minmax(0,1fr)]" data-tag-family={g.key}>
          <dt className="pt-[3px] text-[10px] leading-4 font-semibold tracking-[1.1px] text-dim uppercase">{g.label}</dt>
          <dd className="m-0 flex flex-wrap gap-1.5">
            {g.rows.map((r) => (
              <span key={r.key} className="rounded-brief border border-line-strong px-1.5 py-px text-[12px] leading-[18px] text-ink">
                {r.label}
              </span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
  return (
    <FigureFrame
      meta={{ number, title: figure.title, caption: figure.caption ?? undefined, source: sourceOf(figure), id: `figure-${number}`, formulaId: null }}
      plot={plot}
      table={null}
    />
  );
}

function FigureView({ figure, number, compact = false }: { figure: DesFigure; number: number; compact?: boolean }) {
  const style = { "--plot-min": `${compact ? 0 : MIN_FULL_PLOT}px` } as CSSProperties;
  return (
    <div className={cx("flex h-full min-w-0 flex-col", styles.figure)} style={style} data-figure={number} data-kind={figure.dataset.kind}>
      {figure.display === "tags" ? (
        <TagsFigure figure={figure} number={number} />
      ) : (
        <Exhibit
          dataset={figure.dataset}
          number={number}
          title={figure.title}
          label={figure.title}
          caption={figure.caption ?? undefined}
          source={sourceOf(figure)}
          id={`figure-${number}`}
          display={displayOf(figure, compact ? HALF_WIDTH : FULL_WIDTH)}
          className="flex-1"
        />
      )}
    </div>
  );
}

/** A section's gap, or its status when it has nothing at all to show. */
function Gap({ section }: { section: DesSection }) {
  if (section.gap === null) return null;
  return (
    <p className={cx(BODY, "border-l-2 py-0.5 pl-3", section.status === "failed" ? "border-negative" : "border-line-strong")} data-gap={section.status}>
      {section.gap}
    </p>
  );
}

function SectionNotes({ notes, first }: { notes: readonly string[]; first: number }) {
  if (notes.length === 0) return null;
  return (
    <div className="flex flex-col gap-4">
      {notes.map((text, i) => (
        <SideNote key={text} n={first + i} text={text} />
      ))}
    </div>
  );
}

// The ready tearsheet ---------------------------------------------------------------------------------

export interface TearsheetViewProps {
  sheet: Tearsheet;
  /** When the served tearsheet was computed, if it came from the answer cache. */
  cachedAt: string | null;
  /** A curated entity (indexed); every other tearsheet is a reader's own lookup, unlisted (D31). */
  curated: boolean;
}

export function TearsheetView({ sheet, cachedAt, curated }: TearsheetViewProps) {
  const { sections } = sheet;
  // Figures are numbered in reading order; notes too, section by section.
  const numbered = (figures: readonly DesFigure[], first: number) => figures.map((figure, i) => ({ figure, number: first + i }));
  const dna = numbered(sections.dna.figures, 1);
  const neighbours = numbered(sections.neighbours.figures, 1 + dna.length);
  const travel = numbered(sections.travel.figures, 1 + dna.length + neighbours.length);
  const figureCount = dna.length + neighbours.length + travel.length;
  const firstNote = { dna: 1, neighbours: 1 + sections.dna.notes.length, travel: 1 + sections.dna.notes.length + sections.neighbours.notes.length };

  const { traced, requests } = sheet;
  const computed = formatUtcDateTime(sheet.computedAt);
  const outline = (
    <Outline
      heading="On this tearsheet"
      spyOffset={REFERENCE_STICKY_TOP + 24}
      items={SECTION_ORDER.map((s) => ({ id: s.id, label: s.label, ...(s.id === "receipts" ? { count: requests.total } : {}) }))}
      meta={{ trace: sheet.mnemonic, text: `${plural(figureCount, "figure")} · ${plural(requests.total, "request")} · no LLM` }}
    />
  );
  const type = DES_TYPE_LABEL[sheet.entity.type];
  const lede = [type, sheet.entity.disambiguation].filter(Boolean).join(" · ");
  const extra: ReactNode[] = [
    type,
    cachedAt ? `Computed ${formatUtcDateTime(cachedAt)} UTC` : `Computed ${formatUtcTime(sheet.computedAt)} UTC`,
    <span key="cost">$0 LLM · code only</span>,
    curated ? (
      <span key="listed" className="font-semibold tracking-[1.1px] text-accent uppercase">
        Curated
      </span>
    ) : (
      <span key="listed" className="font-semibold tracking-[1.1px] uppercase" data-unlisted="true">
        Unlisted · reader lookup
      </span>
    ),
  ];
  const renamed = sheet.entity.name !== sheet.query.name;

  return (
    <ReferenceGrid outline={outline}>
      <BriefRow
        notes={
          <TraceNote
            head={`${traced.traced}/${traced.total} numbers traced`}
            detail={`${plural(requests.total, "Qloo request")} · ${requests.cached} cached · no LLM call · ${computed} UTC`}
          />
        }
      >
        {/* On a phone the trace note folds under the search box: keep them apart. */}
        <div className="flex flex-col gap-6 max-md:pb-5">
          <Head
            kicker="Tearsheet"
            extra={extra}
            title={sheet.entity.name}
            lede={
              <>
                {lede}. Who its audience is, what else that audience loves and where its taste travels, computed in code from Qloo
                with no language model.
                {renamed ? <span className="block pt-1 text-[14px] leading-5 text-dim">Looked up as “{sheet.query.name}”.</span> : null}
              </>
            }
          />
          {cachedAt ? (
            <p className="m-0 text-[12px] leading-[17px] text-dim" data-cached="true">
              Served from the tearsheet cache: computed {formatUtcDateTime(cachedAt)} UTC, no request repeated.
            </p>
          ) : null}
          <DesSearch name="" type={sheet.query.type} compact />
        </div>
      </BriefRow>

      <BriefRow>
        <Section id="overview" n={1} title="Overview" aside="Key figures">
          <KeyFigures figures={sheet.keyFigures} />
          <p className={BODY}>
            Each figure links to the Qloo request behind it. Indices run from −1 to 1 around the average audience (0); they are
            relative affinities, never shares of customers.
          </p>
        </Section>
      </BriefRow>

      <BriefRow notes={<SectionNotes notes={sections.dna.notes} first={firstNote.dna} />}>
        <Section id="dna" n={2} title="Audience DNA" aside={SECTION_ASIDE.dna}>
          <p className={BODY}>
            {SECTION_LEDE.dna}
            {sections.dna.notes.length > 0 ? <NoteRef n={firstNote.dna} /> : null}
          </p>
          <Gap section={sections.dna} />
          {dna.map(({ figure, number }) => (
            <FigureView key={figure.key} figure={figure} number={number} />
          ))}
        </Section>
      </BriefRow>

      <BriefRow notes={<SectionNotes notes={sections.neighbours.notes} first={firstNote.neighbours} />}>
        <Section id="neighbours" n={3} title="Cultural neighbours" aside={SECTION_ASIDE.neighbours}>
          <p className={BODY}>
            {SECTION_LEDE.neighbours}
            {sections.neighbours.notes.length > 0 ? <NoteRef n={firstNote.neighbours} /> : null}
          </p>
          <Gap section={sections.neighbours} />
          {neighbours.length > 0 ? (
            <div className="grid grid-cols-1 gap-x-6 gap-y-7 sm:grid-cols-2" data-neighbour-lists={neighbours.length}>
              {neighbours.map(({ figure, number }) => (
                <FigureView key={figure.key} figure={figure} number={number} compact />
              ))}
            </div>
          ) : null}
        </Section>
      </BriefRow>

      <BriefRow notes={<SectionNotes notes={sections.travel.notes} first={firstNote.travel} />}>
        <Section id="travel" n={4} title="Travel taste" aside={SECTION_ASIDE.travel}>
          <p className={BODY}>
            {SECTION_LEDE.travel}
            {sections.travel.notes.length > 0 ? <NoteRef n={firstNote.travel} /> : null}
          </p>
          <Gap section={sections.travel} />
          {travel.map(({ figure, number }) => (
            <FigureView key={figure.key} figure={figure} number={number} />
          ))}
        </Section>
      </BriefRow>

      <BriefRow>
        <Section id="receipts" n={5} title="Receipts" aside={`${plural(requests.total, "request")} · ${requests.cached} cached`}>
          <p className={BODY} data-picked={sheet.picked}>
            Every Qloo request behind this page, in the order it was made.{" "}
            {sheet.picked
              ? "You picked this entity from Qloo's candidates; nothing was picked for you."
              : "The name was matched exactly, name and type, before anything was read; nothing was substituted."}
          </p>
          <Receipts receipts={sheet.receipts} />
        </Section>
      </BriefRow>
    </ReferenceGrid>
  );
}

// The other outcomes ----------------------------------------------------------------------------------

function StateCard({ tone, label, kicker, children }: { tone: "accent" | "negative" | "dim"; label: string; kicker: string; children: ReactNode }) {
  return (
    <section
      aria-label={label}
      className={cx(
        "flex w-full flex-col gap-3 border-l-2 py-1 pl-4",
        tone === "accent" ? "border-accent" : tone === "negative" ? "border-negative" : "border-line-strong",
      )}
      data-state-card={label}
    >
      <p className={cx(KICKER, tone === "accent" ? "text-accent" : tone === "negative" ? "text-negative" : "text-dim")}>{kicker}</p>
      {children}
    </section>
  );
}

function Candidates({ candidates }: { candidates: readonly DesCandidate[] }) {
  return (
    <ul className="m-0 flex list-none flex-col border-t border-line p-0" aria-label="Candidates">
      {candidates.map((c) => (
        <li key={c.key} className="border-b border-line">
          <Link href={c.href} prefetch={false} className="flex w-full items-center gap-4 py-2.5 text-left hover:bg-canvas" data-candidate={c.key}>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] leading-[22px] font-medium text-ink">{c.name}</span>
              <span className="block text-[12px] leading-[17px] text-dim">{c.disambiguation ?? "no other detail from Qloo"}</span>
            </span>
            {c.popularity !== null ? (
              <span className="flex shrink-0 items-center gap-2 text-[12px] text-dim tabular-nums">
                <span className="max-sm:sr-only">Popularity</span>
                <MiniMeter value={c.popularity * 100} label={`Popularity of ${c.name}`} width={48} markerHeight={9} />
                {c.popularity.toFixed(2).replace(/^0/, "")}
              </span>
            ) : null}
            <span className="w-12 shrink-0 text-right text-[13px] font-medium text-accent">Open</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const typeWord = (type: DesType): string => DES_TYPE_LABEL[type].toLowerCase();

function OutcomeCard({ outcome }: { outcome: Exclude<DesOutcome, { kind: "ready" }> }) {
  switch (outcome.kind) {
    case "pick":
      return (
        <StateCard tone="accent" label="Pick the one you mean" kicker="Which one do you mean?">
          <p className="m-0 font-serif text-[20px] leading-[28px] text-ink">
            “{outcome.query.name}” matches several {typeWord(outcome.query.type)} entries exactly.
          </p>
          <p className="m-0 type-body text-text-2">{outcome.message}</p>
          <Candidates candidates={outcome.candidates} />
          <p className="m-0 text-[12px] leading-[17px] text-dim">
            Nothing was picked for you. Popularity helps you tell them apart; it never decides the match.
          </p>
        </StateCard>
      );
    case "not_found":
      return (
        <StateCard tone="accent" label="Name not found" kicker="Not found">
          <p className="m-0 font-serif text-[20px] leading-[28px] text-ink">
            No {typeWord(outcome.query.type)} in Qloo&apos;s data is named exactly “{outcome.query.name}”.
          </p>
          <p className="m-0 type-body text-text-2">{outcome.message}</p>
          {outcome.candidates.length > 0 ? (
            <>
              <p className="m-0 text-[12px] text-dim">Closest names in Qloo&apos;s data, offered and never applied:</p>
              <Candidates candidates={outcome.candidates} />
            </>
          ) : null}
          <p className="m-0 text-[12px] leading-[17px] text-dim">Nothing was substituted: a near miss is never applied for you.</p>
        </StateCard>
      );
    case "refused":
      return (
        <StateCard tone="negative" label="Lookup refused" kicker="Not looked up · not a vetted public figure">
          <p className="m-0 font-serif text-[20px] leading-[28px] text-ink">Tearsheets describe public figures only.</p>
          <p className="m-0 type-body text-text-2">{outcome.message}</p>
          <p className="m-0 text-[12px] leading-[17px] text-dim">Group-level taste only: no individuals, no politics, no buy or sell advice.</p>
        </StateCard>
      );
    case "unavailable":
      return (
        <StateCard tone="dim" label="Tearsheets unavailable" kicker={outcome.cause === "budget" ? "Paused · daily budget" : "Unavailable"}>
          <p className="m-0 font-serif text-[20px] leading-[28px] text-ink">{outcome.message}</p>
          <p className="m-0 text-[13px] leading-5 text-dim">
            <Link href="/" className="font-medium text-accent hover:underline hover:underline-offset-4">
              Open the showcases
            </Link>{" "}
            or see{" "}
            <Link href="/status" prefetch={false} className="font-medium text-accent hover:underline hover:underline-offset-4">
              the server&apos;s status
            </Link>
            .
          </p>
        </StateCard>
      );
    case "limited":
      return (
        <StateCard tone="dim" label="Too many lookups" kicker="Slow down">
          <p className="m-0 font-serif text-[20px] leading-[28px] text-ink">{outcome.message}</p>
        </StateCard>
      );
    case "failed":
      return (
        <StateCard tone="negative" label="Lookup failed" kicker="Failed">
          <p className="m-0 font-serif text-[20px] leading-[28px] text-ink">{outcome.message}</p>
        </StateCard>
      );
  }
}

export interface DesStateViewProps {
  /** What was asked, when the address named something a tearsheet can look up. */
  query: { name: string; type: DesType } | null;
  /** The outcome; null when the address could not be read at all. */
  outcome: Exclude<DesOutcome, { kind: "ready" }> | null;
  /** Shown with the search box when the address or the form could not be read. */
  error?: string | null;
}

/** Every page that is not a ready tearsheet: the head, the state card and the search box. */
export function DesStateView({ query, outcome, error = null }: DesStateViewProps) {
  // A refused name is not repeated back: the heading and the search box stay neutral.
  const refused = outcome?.kind === "refused";
  const title = refused ? "Tearsheet" : (query?.name ?? "Describe any entity");
  const retry = outcome?.kind === "failed" || outcome?.kind === "limited" ? (query ? desHref(query) : null) : null;
  return (
    <ReferenceGrid outline={null}>
      <BriefRow
        notes={
          <SideNote
            n={1}
            text="A tearsheet is computed in code from Qloo, with no language model: the name is matched exactly (name and type), then Audience DNA, cultural neighbours and travel taste are read, each number traced to its request."
            trace="DES · P1 · $0 LLM"
          />
        }
      >
        <div className="flex flex-col gap-6 max-md:pb-5">
          <Head
            kicker="Tearsheet"
            extra={query ? [DES_TYPE_LABEL[query.type]] : []}
            title={title}
            lede={
              <>
                One page on one entity: who its audience is, what else that audience loves, and where its taste travels.
                <NoteRef n={1} />
              </>
            }
          />
          {outcome ? <OutcomeCard outcome={outcome} /> : null}
          {retry ? (
            <p className="m-0 text-[13px] leading-5 text-dim">
              <Link href={retry} prefetch={false} className="font-medium text-accent hover:underline hover:underline-offset-4">
                Try this tearsheet again
              </Link>
            </p>
          ) : null}
          <DesSearch name={refused ? "" : (query?.name ?? "")} type={query?.type} error={error} />
        </div>
      </BriefRow>
    </ReferenceGrid>
  );
}
