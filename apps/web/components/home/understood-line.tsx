import { PILLAR_TOPIC, TOPIC_LABEL } from "../../lib/answer/copy";
import type { PreviewResponse } from "../ask/ask-machine";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";

type Understood = NonNullable<PreviewResponse["understood"]>;

/** What the line says: the desk, the names as matched, the cities, and any name read as another. */
export interface UnderstoodParts {
  desk: string;
  names: string[];
  metros: string[];
  /** A typed name read as a different catalogue name ("NWC" as "Northwind Coffee"). */
  swaps: { typed: string; read: string }[];
}

/** The parts of the preview's reading worth showing; names that were not found are left out. */
export function understoodParts(understood: Understood): UnderstoodParts {
  const found = understood.mentions.filter((m) => m.match !== "not_found");
  const names = [...new Set(found.map((m) => m.name ?? m.text))];
  const swaps = found
    .filter((m) => m.name !== null && m.name.trim().toLowerCase() !== m.text.trim().toLowerCase())
    .map((m) => ({ typed: m.text, read: m.name ?? "" }));
  return { desk: understood.jobLabel, names, metros: [...understood.metros], swaps };
}

/** One matched name: how sure the match is, and how it was read. */
interface MatchedName {
  name: string;
  /** exact: the typed name itself; read: the typed text read as this catalogue name. */
  exact: boolean;
  note: string;
}

function matchedNames(understood: Understood): MatchedName[] {
  const seen = new Set<string>();
  const out: MatchedName[] = [];
  for (const m of understood.mentions) {
    if (m.match === "not_found") continue;
    const name = m.name ?? m.text;
    if (seen.has(name)) continue;
    seen.add(name);
    const swapped = m.name !== null && m.name.trim().toLowerCase() !== m.text.trim().toLowerCase();
    const kind = m.type.replace(/_/g, " ");
    out.push({ name, exact: !swapped && m.match === "exact", note: swapped ? `${kind} · read from “${m.text}”` : `${kind} · ${m.match === "exact" ? "exact name" : m.match === "ambiguous" ? "more than one match: you pick" : "closest name"}` });
  }
  return out;
}

const KEY = "w-[120px] shrink-0 text-[12px] leading-5 text-ink-2 max-md:w-full max-md:leading-4";
const ROW = "flex gap-4 border-b border-line py-[9px] last:border-b-0 max-md:flex-col max-md:gap-1";

/**
 * "Understood as", under the box once the question is read: the desk with its topic, the place and the
 * names it matched (a green dot for the exact name, an amber one for a name read from what was typed),
 * so the visitor sees how the question was taken while the answer starts.
 */
export function UnderstoodLine({ understood, className }: { understood: Understood; className?: string }) {
  const parts = understoodParts(understood);
  const names = matchedNames(understood);
  const topic = TOPIC_LABEL[PILLAR_TOPIC[understood.pillar]];
  return (
    <section data-understood="" aria-label="Understood as" className={cx("flex flex-col overflow-hidden rounded-md border border-line bg-surface", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-[18px] py-3 max-md:px-3.5">
        <span className="text-[11px] leading-4 font-semibold tracking-[0.08em] text-ink-2 uppercase">Understood as</span>
        <span className="inline-flex items-center gap-1.5 text-[11px] leading-4 text-accent">
          <Icon name="loader-circle" size={12} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          Starting your answer
        </span>
      </div>
      <dl className="m-0 flex flex-col px-[18px] pt-1.5 pb-2.5 max-md:px-3.5">
        <div className={ROW}>
          <dt className={KEY}>Desk</dt>
          <dd className="m-0 text-[13px] leading-5 text-ink">
            {parts.desk} · {topic}
          </dd>
        </div>
        <div className={ROW}>
          <dt className={KEY}>Place</dt>
          <dd className="m-0 text-[13px] leading-5 text-ink">{understood.scope.trim() !== "" ? understood.scope : parts.metros.join(", ") || "United States"}</dd>
        </div>
        {names.length > 0 ? (
          <div className={ROW}>
            <dt className={KEY}>Names matched</dt>
            <dd className="m-0 flex flex-col gap-1.5">
              {names.map((n) => (
                <span key={n.name} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span aria-hidden="true" className={cx("size-1.5 shrink-0 rounded-full", n.exact ? "bg-good" : "bg-caution")} />
                  <span className="text-[13px] leading-5 text-ink">{n.name}</span>
                  <span className="text-[12px] leading-4 text-ink-2">{n.note}</span>
                </span>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
      {parts.swaps.map((swap) => (
        <p key={`${swap.typed}|${swap.read}`} className="m-0 flex items-center gap-1.5 border-t border-line bg-sunken/50 px-[18px] py-2.5 text-[12px] leading-4 text-ink-2 max-md:px-3.5">
          <Icon name="corner-down-right" size={13} className="shrink-0 text-accent" />
          Read “{swap.typed}” as “{swap.read}”. Not this one? Write the full name.
        </p>
      ))}
    </section>
  );
}
