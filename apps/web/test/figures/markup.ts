// Static-markup helpers for the figure tests: render on the server, then read the plot and the
// table view back out of the HTML. No DOM: the tests run in the node environment.
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/** HTML entities React escapes in text, back to characters. */
export function decode(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Visible text of a fragment, tags removed. */
export function text(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ""));
}

/** The ⧉ table view of a rendered figure (always in the markup, visually hidden until toggled). */
export function tableView(html: string): string {
  const start = html.indexOf('data-view="table"');
  if (start < 0) throw new Error("no table view in the markup");
  const end = html.indexOf("</table>", start);
  return html.slice(start, end + "</table>".length);
}

/** The plot part of a rendered figure. */
export function plotView(html: string): string {
  const start = html.indexOf('data-view="plot"');
  const end = html.indexOf('data-view="table"');
  if (start < 0) throw new Error("no plot view in the markup");
  return html.slice(start, end < 0 ? undefined : end);
}

/** Body rows of a table as arrays of cell texts (sections included as one-cell rows). */
export function tableRows(table: string): string[][] {
  const body = table.slice(table.indexOf("<tbody>"));
  return [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) => text(cell[1]!).trim()),
  );
}

/** Column heads of a table. */
export function tableHeads(table: string): string[] {
  const head = table.slice(table.indexOf("<thead>"), table.indexOf("</thead>"));
  return [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((cell) => text(cell[1]!).trim());
}

/** The markup of one `data-row` group or element. */
export function rowMarkup(html: string, key: string): string {
  const start = html.indexOf(`data-row="${key}"`);
  if (start < 0) throw new Error(`no row ${key}`);
  const next = html.indexOf("data-row=", start + 10);
  return html.slice(start, next < 0 ? undefined : next);
}

/** The markup of one SVG group whose <title> starts with `title`, e.g. a matrix cell "A × B: .71". */
export function groupByTitle(html: string, title: string): string {
  const at = html.indexOf(`<title>${title}`);
  if (at < 0) throw new Error(`no group titled ${title}`);
  const start = html.lastIndexOf("<g", at);
  const end = html.indexOf("</g>", at);
  return html.slice(start, end + "</g>".length);
}

/** The x of every `<rect>` in a fragment with its class, in order. */
export function rects(html: string): { x: number; width: number; cls: string }[] {
  return [...html.matchAll(/<rect x="([-\d.]+)"[^>]*?width="([\d.]+)"[^>]*?class="([^"]*)"/g)].map((m) => ({
    x: Number(m[1]),
    width: Number(m[2]),
    cls: m[3]!,
  }));
}
