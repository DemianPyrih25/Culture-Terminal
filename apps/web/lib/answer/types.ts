import type { ConfidenceBand, DatasetEnvelope, DatasetId, GeoLiftPayload, GhostPickCategory, Job, Metric, MetroId, ResolvedMention, RunState } from "@ct/contracts";
import type { IconName } from "../../components/ui/icons";
import type { BriefArgument, BriefNextMove, Inline } from "../brief";
import type { AnswerTopic } from "./copy";

/**
 * The answer page's view-model (design/redesign.pen N05, N07–N12, N18): everything the finished answer
 * prints, chosen and worded per job from a BriefModel and its run. Plain data, no functions, so the server
 * can build it and the page can print it.
 */

/** What buildAnswerModel reads from the run besides the brief model. */
export type AnswerRun = Pick<RunState, "resolves"> &
  Partial<Pick<RunState, "ghost" | "report" | "intent" | "evidence">> & {
    /** The run's metrics by id (the raw values behind the key numbers). */
    metrics?: Readonly<Record<string, Metric>>;
  };

export type AnswerConfidence = ConfidenceBand | "insufficient_evidence";

export interface AnswerHead {
  topic: AnswerTopic | null;
  /** "Brands & investing · Real competitors · Data as of 23 Oct 2026". */
  eyebrow: string;
  /** The phone eyebrow: "Brands & investing · 23 Oct 2026". */
  mobileEyebrow: string;
  question: string;
  /** head_to_head: the two names for the compare monograms. */
  compare: { subject: string; second: string } | null;
}

/**
 * The nearest-job rule (D41, ANSWER_QUALITY §8): the question asked for more than any job covers, so it
 * was read as the closest job. The top of the answer says which job, and in a plain sentence what is
 * not covered and why.
 */
export interface AnswerReadAs {
  /** "Real competitors": the job the question was read as. */
  jobLabel: string;
  /** What the data does not cover, a few words each ("sales", "rents"); empty when only the sentence is known. */
  notCovered: string[];
  /** The plain sentence under the chip. */
  text: string;
}

export interface AnswerVerdict {
  /** answer: a call; not_enough: the data could not support one. */
  kind: "answer" | "not_enough";
  /** The verdict line (display-l), with its period. */
  line: string;
  headline: Inline[] | null;
  confidence: AnswerConfidence | null;
  /** What lowered the confidence, in a reader's words. */
  lowered: string[];
  /** "Taste signals, not buy or sell advice." on the investment desk; null elsewhere. */
  advice: string | null;
  /** "All 28 numbers checked against Qloo data" (or "Qloo and SEC data"); `ok` false prints the caution form. */
  check: { ok: boolean; text: string } | null;
}

export interface AnswerStep {
  word: "Now" | "Next" | "Later";
  text: string;
}

export type KeyNumberTag = "hidden-gem" | "few-rivals" | "new-here" | "outside-category";

export type AnswerKeyNumber =
  | {
      key: string;
      variant: "number" | "word" | "name";
      value: string;
      label: string;
      tag: KeyNumberTag | null;
      context: string | null;
      /** The footnote "Source" opens; null shows no Source. */
      footnote: number | null;
    }
  | {
      key: string;
      variant: "split";
      sides: [{ name: string; value: string; tone: "subject" }, { name: string; value: string; tone: "second" }];
      label: string;
      tag: null;
      context: null;
      footnote: number | null;
    };

/** A legend item: a dot colour and its words. */
export interface ChartLegendItem {
  label: string;
  tone: "accent" | "second" | "muted" | "good";
}

export interface ChartTableData {
  columns: { label: string; numeric?: boolean }[];
  rows: string[][];
}

export type BarTone = "accent" | "muted" | "second";

export interface BarRowData {
  label: string;
  sublabel: string | null;
  /** 0–1 of the track. */
  fraction: number;
  display: string;
  tone: BarTone;
  tag: KeyNumberTag | null;
}

export interface WinnerRowData {
  label: string;
  /** "a": the subject leads; "b": the second leads; null: even or no data. */
  winner: "a" | "b" | null;
}

export interface MiniBarData {
  label: string;
  display: string;
  fraction: number;
  tag: KeyNumberTag | null;
}

export interface PairRowData {
  group: string;
  less: { label: string; display: string; fraction: number } | null;
  more: { label: string; display: string; fraction: number } | null;
}

export interface FitRowData {
  rank: number;
  label: string;
  /** 0–1 of the track. */
  fraction: number;
  display: string;
  climbs: boolean;
}

export interface SlateRowData {
  category: string;
  icon: "beer" | "wine" | "tent" | "shirt" | "utensils" | "glass-water" | "shopping-bag";
  best: string | null;
  /** The best fit's profile page. */
  href: string | null;
  fraction: number;
  display: string;
  gem: boolean;
  /** Why the category has no best fit. */
  missing: string | null;
}

export interface ListItemData {
  rank: number;
  label: string;
  gem: boolean;
  /** The name's profile page, when its type has one. */
  href: string | null;
}

export interface DivergingRowData {
  label: string;
  value: number | null;
  display: string;
}

export interface RankTrackRowData {
  label: string;
  sublabel: string | null;
  rank: number | null;
  of: number;
  display: string;
  gem: boolean;
}

/** A concept check's verdict on one name (S12): kept, found in the data, dropped, or not scored. */
export type VerdictKind = "keep" | "add" | "veto" | "unscored";

export interface VerdictRowData {
  label: string;
  /** The value as printed ("0.12 above the bar"), or a reason. */
  display: string;
  /** The name's profile page, when its type has one; never for a dropped name. */
  href: string | null;
}

export interface VerdictGroupData {
  verdict: VerdictKind;
  /** "Kept: the data backs these". */
  title: string;
  rows: VerdictRowData[];
}

/** A row of a figure printed as a table (financials, economics): its name, sublabel and one cell per column. */
export interface DataRowData {
  label: string;
  sublabel: string | null;
  cells: string[];
  /** A comparator row (the whole city), drawn apart from the rows it is compared with. */
  comparison: boolean;
}

export interface MapAreaData {
  rank: number;
  name: string;
  display: string;
  fewRivals: boolean;
}

export type ChartBody =
  | { type: "bars"; rows: BarRowData[] }
  | {
      type: "winner";
      a: string;
      b: string;
      score: { a: number; b: number; label: string } | null;
      tables: { title: string; rows: WinnerRowData[] }[];
    }
  | { type: "map"; data: GeoLiftPayload | null; areas: MapAreaData[]; caption: string }
  | { type: "more-less"; more: MiniBarData[]; less: MiniBarData[]; heads?: [string, string] }
  | { type: "pair"; rows: PairRowData[] }
  | { type: "fit"; rows: FitRowData[]; climbLabel: string }
  | { type: "slate"; rows: SlateRowData[] }
  | { type: "numbered"; rows: ListItemData[] }
  | { type: "neighbours"; columns: { key: string; label: string; icon: IconName; items: ListItemData[] }[] }
  | { type: "diverging"; rows: DivergingRowData[]; max: number }
  | { type: "ranks"; rows: RankTrackRowData[] }
  | { type: "verdicts"; groups: VerdictGroupData[] }
  | { type: "rows"; columns: { label: string; numeric?: boolean }[]; rows: DataRowData[] };

export interface AnswerChart {
  datasetId: DatasetId;
  /** The figure's footnote, opened by Source. */
  footnote: number;
  kind: string;
  title: string;
  caption: string | null;
  legend: ChartLegendItem[];
  /** The Table view; null hides the switch. */
  table: ChartTableData | null;
  /** Kind and controls over the title (long titles). */
  stacked: boolean;
  body: ChartBody;
}

export interface AnswerGhostName {
  name: string;
  /** In both lists. */
  both: boolean;
}

export interface AnswerGhost {
  category: GhostPickCategory;
  title: string;
  subline: string;
  ai: AnswerGhostName[];
  data: AnswerGhostName[];
}

export interface AnswerWhy {
  count: number;
  thesis: Inline[] | null;
  arguments: BriefArgument[];
}

export interface MoreChart {
  datasetId: DatasetId;
  /** The figure's number in the report (for ?chart=). */
  number: number;
  name: string;
  glyph: "bars" | "diverging" | "columns" | "dots";
}

export interface AnswerArea {
  metro: MetroId;
  /** The gazetteer's name ("ZIP 37206 (East Nashville)"), which finds the boundary. */
  name: string;
  /** The name a reader knows ("East Nashville"). */
  label: string;
  corner: boolean;
}

export type AnswerCell =
  | { slot: "main" | "second" | "third" | "map"; span: 2 | 3 | 4 | 6 }
  | { slot: "guesses"; span: 2 | 3 | 6 };

export interface AnswerModel {
  runId: string;
  job: Job | null;
  head: AnswerHead;
  /** The "Read as" chip and what the answer does not cover; null when the question fit its job. */
  readAs: AnswerReadAs | null;
  verdict: AnswerVerdict;
  steps: AnswerStep[];
  keyNumbers: AnswerKeyNumber[];
  /** `third`: public figures beside the taste read (SEC financials, Census economics), on their own row. */
  charts: { main: AnswerChart | null; second: AnswerChart | null; third: AnswerChart | null; map: AnswerChart | null };
  /**
   * tenant_mix and area_profile: the area the answer reads, drawn as its boundary in the map slot (no
   * dataset behind it). `corner` pins the visitor's space on a tenant question.
   */
  area: AnswerArea | null;
  /**
   * site_selection: the lift map is still loading (fetched after the first paint), so the map slot keeps
   * its place with a placeholder of the card's height and nothing below it moves when the map arrives.
   */
  mapPending?: boolean;
  /** Rows C and D: the cells in order, each a chart slot or the guesses, with its span of 6. */
  rows: AnswerCell[][];
  /** No AI alone card and the guesses had a row to themselves: they sit beside Change in row E (4 + 2). */
  guessesBesideChange: boolean;
  ghost: AnswerGhost | null;
  /** Row E: AI alone + Change as 3+3 or 4+2. */
  ghostSpan: 3 | 4;
  changes: string[];
  why: AnswerWhy;
  more: MoreChart[];
  ask: { moves: BriefNextMove[]; placeholder: string };
}

/** Datasets fetched after the first paint, by dataset id (large ones are not streamed inline). */
export type AnswerDatasets = Readonly<Record<string, DatasetEnvelope | null | undefined>>;

/** The run's primary and second subjects, as resolved. */
export interface AnswerSubjects {
  primary: ResolvedMention | null;
  second: ResolvedMention | null;
}
