import type { CellText } from "./format";

/**
 * The ⧉ table view every figure carries (PLAN §8.3): the same numbers as the plot, one row per
 * mark, with every absence spelled out ("not scored") instead of a blank or a 0.
 */

export interface TableColumn {
  label: string;
  numeric?: boolean;
}

/** A plain cell, a formatted value, or an explained absence. */
export type TableCell = string | CellText;

export type TableRow =
  | { key: string; cells: readonly TableCell[] }
  /** A section heading row, e.g. "AGE" or a domain. */
  | { key: string; section: string };

export interface TableSpec {
  /** The accessible caption, normally the figure's plain-text title. */
  caption: string;
  /** The first column heads the row headers. */
  columns: readonly TableColumn[];
  rows: readonly TableRow[];
}

type DataRow = Extract<TableRow, { cells: readonly TableCell[] }>;

/** Rows split at each section heading: one tbody per section, so the heading heads its rows. */
function bodiesOf(rows: readonly TableRow[]): { key: string; section: string | null; rows: DataRow[] }[] {
  const bodies: { key: string; section: string | null; rows: DataRow[] }[] = [];
  for (const row of rows) {
    if ("section" in row) bodies.push({ key: row.key, section: row.section, rows: [] });
    else {
      if (bodies.length === 0) bodies.push({ key: "rows", section: null, rows: [] });
      bodies[bodies.length - 1]!.rows.push(row);
    }
  }
  return bodies.length > 0 ? bodies : [{ key: "rows", section: null, rows: [] }];
}

export function FigureTable({ spec }: { spec: TableSpec }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-ui text-[12px] text-text-2">
        <caption className="sr-only">{spec.caption}</caption>
        <thead>
          <tr className="border-b border-line-strong">
            {spec.columns.map((c, i) => (
              <th
                key={`${i}-${c.label}`}
                scope="col"
                className={`px-2 py-1.5 text-[10px] font-semibold tracking-[1px] text-dim uppercase ${
                  c.numeric ? "text-right" : "text-left"
                }`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        {bodiesOf(spec.rows).map((body) => (
          <tbody key={body.key}>
            {body.section !== null ? (
              <tr className="border-b border-line">
                <th
                  scope="rowgroup"
                  colSpan={spec.columns.length}
                  className="px-2 pt-2.5 pb-1 text-left text-[9.5px] font-semibold tracking-[1px] text-dim uppercase"
                >
                  {body.section}
                </th>
              </tr>
            ) : null}
            {body.rows.map((row) => (
              <tr key={row.key} className="border-b border-line">
                {row.cells.map((cell, i) => {
                  const numeric = spec.columns[i]?.numeric ?? false;
                  const content = renderCell(cell);
                  const cls = `px-2 py-1 align-top ${numeric ? "text-right tabular-nums" : "text-left"}`;
                  return i === 0 ? (
                    <th key={i} scope="row" className={`${cls} font-medium text-ink`}>
                      {content}
                    </th>
                  ) : (
                    <td key={i} className={cls}>
                      {content}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function renderCell(cell: TableCell) {
  if (typeof cell === "string") return cell;
  if (cell.kind === "value") return cell.text;
  return (
    <span className="text-dim italic" data-missing="true">
      {cell.reason}
    </span>
  );
}
