import type { ConfidenceBand, DatasetEnvelope, DatasetId, RunState } from "@ct/contracts";
import { formatUsd, inlineText, SIGNAL_LABEL, type BriefModel } from "../brief";
import { fitWidth, type CardType } from "./measure";
import { miniViz, type MiniViz } from "./mini-viz";
import { cardLabel, cardText, truncate } from "./text";
import { labelTracking, OG_FRAME } from "./tokens";

/**
 * The share card of a curated showcase (P1 #4, SPEC §8.6, D31): the question, the signal line, a mini
 * viz of the lead figure with its key figures, and the receipt strip. Built from the brief model the
 * permalink renders, so the card says what the brief says. Plain data: lib/og/card-image.tsx draws it,
 * and every string on it has been through cardText (the fonts' characters, no ids).
 */

export interface OgKeyFigure {
  /** "0.56", "1 of 6", "1.48×": the brief's own key-figure text. */
  value: string;
  label: string;
  comparator: string | null;
}

export type OgPanel =
  | { kind: "figure"; number: number; title: string; viz: MiniViz; keyFigures: OgKeyFigure[] }
  /** No figure the card can draw: the key figures alone. */
  | { kind: "key_figures"; keyFigures: OgKeyFigure[] }
  | { kind: "refusal"; category: string | null; message: string; reframe: string | null };

export interface OgQuestion {
  text: string;
  /** Serif size and line height in px, and the most lines it may take: longer questions set smaller. */
  size: number;
  lineHeight: number;
  lines: number;
}

export interface OgCard {
  /** The image's alt text (og:image:alt). */
  alt: string;
  head: { desk: string | null; job: string | null; brief: string; date: string | null };
  question: OgQuestion;
  signal: {
    /** The answer's tag: "Mixed signal", "Question refused". */
    tag: string;
    /** "INCOMPLETE" for an evidence digest. */
    marker: string | null;
    /** The verdict tag, "Taste island"; null when the report has none beyond its signal. */
    finding: string | null;
    conviction: { text: string; band: ConfidenceBand; position: number } | null;
  };
  panel: OgPanel | null;
  /** The receipt strip: "Qloo 21 req · 5 cached", "25/25 numbers traced", "LLM $0.10". */
  receipt: string[];
  honesty: string;
}

/** The status line's short honesty line (components/chrome/status-line.tsx, HONESTY_SHORT), on every card. */
export const OG_HONESTY = "Not financial advice · Group-level · No individuals";

/** The longest question a card prints; a longer one ends in an ellipsis at a word boundary. */
export const QUESTION_MAX = 220;

/** Question sizes by length: each tier fits its longest question in the left column (600 px). */
const QUESTION_TIERS: readonly (Omit<OgQuestion, "text"> & { upTo: number })[] = [
  { upTo: 64, size: 52, lineHeight: 60, lines: 4 },
  { upTo: 110, size: 42, lineHeight: 50, lines: 5 },
  { upTo: 160, size: 34, lineHeight: 42, lines: 6 },
  { upTo: QUESTION_MAX, size: 30, lineHeight: 38, lines: 7 },
];

const FINDING_MAX = 32;
const TITLE_MAX = 96;
const KEY_VALUE_MAX = 14;
const MESSAGE_MAX = 180;
const KEY_FIGURES = 2;

/** How a key figure's label and its comparator line (in capitals) are set (lib/og/card-image.tsx). */
export const KEY_LABEL_TYPE: CardType = { face: "sans-400", size: 14 };
export const KEY_COMPARATOR_TYPE: CardType = { face: "sans-600", size: 11, tracking: labelTracking(11), upper: true };

/** The width of one key figure's slot in px when `count` of them share the right column. */
export function keySlotWidth(count: number): number {
  const n = Math.max(1, count);
  return Math.floor((OG_FRAME.right - OG_FRAME.keyGap * (n - 1)) / n);
}

/** The question as the card sets it: cleaned, cut to QUESTION_MAX at a word, sized by its length. */
export function questionText(raw: string | null | undefined): OgQuestion {
  const text = truncate(cardText(raw), QUESTION_MAX) || "A Culture Terminal brief";
  const tier = QUESTION_TIERS.find((t) => text.length <= t.upTo) ?? QUESTION_TIERS[QUESTION_TIERS.length - 1]!;
  return { text, size: tier.size, lineHeight: tier.lineHeight, lines: tier.lines };
}

/** The brief's first ready key figures, as the card prints them; fitted to their slots by `fitted`. */
function keyFigures(model: BriefModel): OgKeyFigure[] {
  return model.evidence.keyFigures
    .flatMap((k) => {
      const value = k.state === "ready" ? cardLabel(k.value, KEY_VALUE_MAX) : "";
      const label = cardText(k.label);
      return value && label ? [{ value, label, comparator: cardText(k.comparator) || null }] : [];
    })
    .slice(0, KEY_FIGURES);
}

/**
 * Key figures in slots `width` px wide: a label too long is cut at a word; a comparator loses its
 * trailing " · " parts first ("top half in 4 of 8 · vs peers" reads "top half in 4 of 8").
 */
function fitted(figures: readonly OgKeyFigure[], width: number): OgKeyFigure[] {
  return figures.map((k) => ({
    value: k.value,
    label: fitWidth(k.label, KEY_LABEL_TYPE, width),
    comparator: k.comparator === null ? null : fitWidth(k.comparator, KEY_COMPARATOR_TYPE, width, { segments: true }),
  }));
}

function panelOf(model: BriefModel, datasets: ReadonlyMap<DatasetId, DatasetEnvelope>): OgPanel | null {
  const terminal = model.terminal;
  if (terminal?.kind === "refused") {
    return {
      kind: "refusal",
      category: cardText(terminal.categoryLabel) || null,
      message: cardLabel(terminal.message, MESSAGE_MAX),
      reframe: cardLabel(terminal.reframe, MESSAGE_MAX) || null,
    };
  }
  const figures = keyFigures(model);
  for (const figure of model.evidence.figures) {
    const viz = miniViz(figure.dataset ?? datasets.get(figure.datasetId) ?? null);
    if (viz) return { kind: "figure", number: figure.number, title: cardLabel(figure.title, TITLE_MAX), viz, keyFigures: fitted(figures, keySlotWidth(figures.length)) };
  }
  // Without a figure the key figures stack, each the column's width.
  return figures.length > 0 ? { kind: "key_figures", keyFigures: fitted(figures, OG_FRAME.right) } : null;
}

export interface OgCardInput {
  model: BriefModel;
  state: RunState;
  /** The run row's question, for a run whose state has none. */
  question?: string | null;
  /** Datasets the stream did not carry inline (BriefFigure.needsFetch), by id. */
  datasets?: ReadonlyMap<DatasetId, DatasetEnvelope>;
}

/**
 * A brief with something to put on a card: a written report (a note or an evidence digest), or a
 * refusal (the trust example). A run stored without its report gets no card.
 */
export function hasOgCard(model: BriefModel, state: RunState): boolean {
  return state.report !== null || model.terminal?.kind === "refused";
}

/** The card for a finished brief. The caller decides that it is a showcase (D31) and that it hasOgCard. */
export function buildOgCard({ model, state, question, datasets = new Map() }: OgCardInput): OgCard {
  const { header } = model;
  const q = questionText(header.question ?? question);
  const report = state.report;
  const signalLabel = header.signal?.label ?? null;
  const finding = header.finding && header.finding !== signalLabel ? cardLabel(header.finding, FINDING_MAX) || null : null;
  const conviction = header.conviction
    ? { text: cardText(header.conviction.text), band: header.conviction.band, position: header.conviction.position }
    : null;
  const tag = cardText(model.answer.tag) || cardText(signalLabel) || "Brief";
  const usd = report?.receipt.usd ?? state.usage?.llmUsd ?? 0;
  const receipt = [cardText(model.statusLine.requests), cardText(model.trace.headline), `LLM ${formatUsd(usd)}`].filter(Boolean);

  const headline = cardText(inlineText(model.answer.headline));
  const verdict = [finding, report ? SIGNAL_LABEL[report.verdict.signal] : tag, conviction ? `conviction ${conviction.text}` : null].filter(Boolean).join(", ");
  const alt = truncate(`${q.text} ${verdict ? `${verdict}.` : ""} ${headline}`.replace(/\s+/g, " ").trim(), 300);

  return {
    alt,
    head: {
      desk: cardText(header.deskLabel) || null,
      job: cardText(header.jobLabel) || null,
      brief: cardText(header.briefLabel),
      date: cardText(header.date) || null,
    },
    question: q,
    signal: { tag, marker: header.incomplete ? "INCOMPLETE" : null, finding, conviction },
    panel: panelOf(model, datasets),
    receipt,
    honesty: OG_HONESTY,
  };
}
