// Plot primitives for the answer and profile pages (design/redesign.pen, N·C chart parts). Each takes plain
// rows the page builds from its data and has a matching `*Table` builder for the ChartCard's Table view:
//   <ChartCard kind title table={<ChartTable label={title} {...barListTable(rows, heads)} />}>
//     <BarList label={title} rows={rows} />
//   </ChartCard>
// Server-safe: no hooks, so pages render them on the server. An empty plot draws the "No data" hatch.
export { BarList, barListTable, barShares } from "./bar-list";
export type { BarListProps, BarListRow } from "./bar-list";
export { ColumnChart, columnDisplay, columnTable } from "./column-chart";
export { DataRows, dataRowsTable } from "./data-rows";
export type { DataRow, DataRowsProps } from "./data-rows";
export type { ColumnChartProps, ColumnPoint } from "./column-chart";
export { DIVERGING_DIRECTIONS, DivergingRows, divergingDisplay, divergingShares, divergingTable } from "./diverging-rows";
export type { DivergingRow, DivergingRowsProps } from "./diverging-rows";
export { DivergingPair, PAIR_KEY, divergingPairTable, pairDisplay, pairShares } from "./diverging-pair";
export type { DivergingPairProps, PairGroup, PairSide } from "./diverging-pair";
export { NO_DATA, distance, signed, times } from "./format";
export { ChartGlyph, glyphForDataset } from "./glyph";
export type { GlyphKind } from "./glyph";
export { MiniBarColumns, miniBarDisplay, miniBarShares, miniBarTable } from "./mini-bars";
export type { MiniBarColumn, MiniBarColumnsProps, MiniBarRow } from "./mini-bars";
export { NEIGHBOUR_DOMAINS, NeighbourColumns, NumberedList, neighbourTable, numberedListTable } from "./name-lists";
export type { NameItem, NeighbourColumn, NeighbourColumnsProps, NumberedListProps } from "./name-lists";
export { NoDataMark, PlotEmpty, PlotTagView, tagText } from "./parts";
export { RANK_TRACK_CAP, RankTrack, RankTrackList, rankText, rankTrackTable } from "./rank-track";
export type { RankTrackListProps, RankTrackRow } from "./rank-track";
export { CLIMB_LABEL, ClimbLegend, RankedFitList, fitDisplay, rankedFitTable } from "./ranked-fit";
export type { RankedFitListProps, RankedFitRow } from "./ranked-fit";
export { SLATE_HEADS, SlateTable, categoryIcon, slateTable } from "./slate-table";
export type { SlateRow, SlateTableProps } from "./slate-table";
export type { PlotBaseProps, PlotTable, PlotTag, PlotTone } from "./types";
export { Scoreboard, WinnerTable, winnerTable } from "./winner-table";
export type { ScoreboardProps, Side, WinnerRow, WinnerTableProps } from "./winner-table";
export { VerdictList, verdictListTable } from "./verdict-list";
export type { VerdictGroup, VerdictItem, VerdictListProps, VerdictTone } from "./verdict-list";
