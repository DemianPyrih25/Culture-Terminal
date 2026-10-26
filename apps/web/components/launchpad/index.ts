// The Launchpad (PLAN §8.1, Part 6): Home's hero, "Judge in 60 seconds", the showcase desk grid, the
// proof strip with the trust tile, and the footer. Server components; ./load.ts holds the server reads
// and is imported from its file by the page, so this barrel stays free of server-only code.
export { AskFocusLink } from "./ask-focus-link";
export type { AskFocusLinkProps } from "./ask-focus-link";
export { DeskGrid, NOT_PINNED, ShowcaseTileView } from "./desk-grid";
export type { DeskGridProps } from "./desk-grid";
export { EVAL_METRIC_IDS, evalAsOfText, evalFigures, ordinal } from "./eval-summary";
export type { EvalFigure } from "./eval-summary";
export { coveredWorkflows, DIRECT_REST_REASON, KIT_ROWS, KIT_WORKFLOWS, kitRowText } from "./kit-workflows";
export type { KitRow, KitWorkflow } from "./kit-workflows";
export { DATA_LINE, LaunchpadFooter } from "./launchpad-footer";
export { ACTION_LINK, ASK_ANCHOR, noteHref, replayHref, TRUST_HREF } from "./links";
export { JUDGE_NOT_PINNED, JudgeStrip } from "./judge-strip";
export type { JudgeStripProps } from "./judge-strip";
export { ProofStrip, TrustTile } from "./proof-strip";
export type { ProofStripProps, TrustTileProps } from "./proof-strip";
export { SHOWCASES, TRUST_QUESTION, TRUST_SLUG } from "./showcases";
export type { Showcase } from "./showcases";
export { ExhibitThumbnail } from "./thumbnail";
export type { ExhibitThumbnailProps } from "./thumbnail";
export {
  isPinned,
  judgeTile,
  launchpadTiles,
  showcaseCard,
  showcasesTraced,
  tilesByDesk,
  unreadCard,
} from "./tiles";
export type { DeskTiles, PinnedTile, ShowcaseCard, ShowcaseFinding, ShowcaseTile } from "./tiles";
