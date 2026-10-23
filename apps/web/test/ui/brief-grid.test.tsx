// The brief grid's breakpoints, as they appear in the markup: 1440 tracks from 1280 px, sidenotes folded
// under the paragraphs below 1280 px, one column with Report | Sources below 768 px.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunningHead } from "../../components/chrome/running-head";
import { StatusLine } from "../../components/chrome/status-line";
import { TopBar } from "../../components/chrome/top-bar";
import { BriefGrid } from "../../components/layout/brief-grid";
import { BriefRow } from "../../components/layout/brief-row";
import { GRID_COLUMNS_MD, GRID_COLUMNS_XL, PAGE_GUTTER } from "../../components/layout/grid";

/** A grid track: its minimum in px, and its maximum in px or "fr" (takes the leftover space). */
interface Track {
  min: number;
  max: number | "fr";
}

/** The tracks of a Tailwind `grid-cols-[...]` class. */
function tracks(cls: string): Track[] {
  const inner = cls.match(/grid-cols-\[(.+)\]$/)?.[1];
  if (!inner) throw new Error(`not a grid-cols class: ${cls}`);
  return inner.split("_").map((t) => {
    const fixed = t.match(/^(\d+)px$/);
    if (fixed) return { min: Number(fixed[1]), max: Number(fixed[1]) };
    const range = t.match(/^minmax\((\d+)(?:px)?,(?:(\d+)px|1fr)\)$/);
    if (!range) throw new Error(`unknown track ${t}`);
    return { min: Number(range[1]), max: range[2] === undefined ? "fr" : Number(range[2]) };
  });
}

/** The sum of the fixed tracks at their widest: what the outer margins leave the page. */
function fixedWidth(list: Track[]): number {
  return list.reduce((sum, t) => sum + (t.max === "fr" ? 0 : t.max), 0);
}

/** Track start positions at a width where every fixed track reaches its maximum (fr tracks share the rest). */
function starts(list: Track[], width: number): number[] {
  const frs = list.filter((t) => t.max === "fr").length;
  const fr = (width - fixedWidth(list)) / frs;
  const out: number[] = [];
  let x = 0;
  for (const t of list) {
    out.push(x);
    x += t.max === "fr" ? fr : t.max;
  }
  return out;
}

const XL = tracks(GRID_COLUMNS_XL);
const MD = tracks(GRID_COLUMNS_MD);

function render(defaultTab?: "report" | "sources") {
  return renderToStaticMarkup(
    <BriefGrid outline={<nav aria-label="Outline">outline</nav>} defaultTab={defaultTab}>
      <BriefRow notes={<p>note one</p>}>
        <p>paragraph one</p>
      </BriefRow>
      <BriefRow>
        <p>paragraph two</p>
      </BriefRow>
    </BriefGrid>,
  );
}

/** The class attribute of the element whose opening tag contains `marker`. */
function classOf(html: string, marker: string): string {
  const tag = html.split("<").find((t) => t.includes(marker));
  if (!tag) throw new Error(`no element with ${marker}`);
  return tag.match(/class="([^"]*)"/)?.[1] ?? "";
}

describe("grid tracks", () => {
  it("puts the outline, reading column and sidenotes where A00 and PZ7B9 put them at 1440", () => {
    // margin · outline · gutter · reading · gutter · sidenotes · margin
    expect(starts(XL, 1440)).toEqual([0, 70, 270, 330, 1010, 1070, 1370]);
    expect(XL.map((t) => t.max)).toEqual(["fr", 200, 60, 680, 60, 300, "fr"]);
    // Wider screens centre the grid: the reading column moves with the margins.
    expect(starts(XL, 1920)[3]).toBe(570);
  });

  it("keeps the md tracks equal to the xl ones, without the sidenote column", () => {
    expect(MD.map((t) => t.max)).toEqual(XL.slice(0, 4).map((t) => t.max).concat("fr"));
    expect(MD[0]).toEqual(XL[0]);
  });

  it("pads the full-bleed bars by exactly the grid's outer margin", () => {
    const margin = XL[0]!.min;
    expect(fixedWidth(XL)).toBe(1300);
    expect(fixedWidth(MD)).toBe(940);
    expect(PAGE_GUTTER).toContain(`md:px-[max(${margin}px,calc((100%-${fixedWidth(MD)}px)/2))]`);
    expect(PAGE_GUTTER).toContain(`xl:px-[max(${margin}px,calc((100%-${fixedWidth(XL)}px)/2))]`);
    for (const html of [renderToStaticMarkup(<TopBar />), renderToStaticMarkup(<StatusLine />)]) {
      expect(html).toContain(PAGE_GUTTER);
    }
  });

  it("puts the running head's md columns on the same tracks as the grid", () => {
    const html = renderToStaticMarkup(<RunningHead desk="Investment" job="Competitors" question="Q?" />);
    const [margin, outline, gutter] = MD;
    expect(html).toContain(`md:grid-cols-[${outline!.max}px_minmax(0,1fr)_auto]`);
    expect(html).toContain(`md:gap-x-[${gutter!.max}px]`);
    expect(html).toContain(`md:px-[max(${margin!.min}px,calc((100%-${fixedWidth(MD)}px)/2))]`);
  });
});

describe("BriefGrid", () => {
  it("lays out the outline, reading and sidenote tracks from 1280 px", () => {
    const html = render();
    const root = classOf(html, "data-tab=");
    expect(root).toContain("xl:grid");
    expect(root).toContain(GRID_COLUMNS_XL);
    expect(root).toContain("md:grid");
    expect(root).toContain(GRID_COLUMNS_MD);
    expect(root).toContain("group/brief");
    // Reading block spans reading · gutter · sidenotes as a subgrid; each row is one too.
    expect(html).toContain("xl:col-[4/span_3] xl:grid xl:grid-cols-subgrid");
    expect(classOf(html, 'role="note"')).toContain("xl:col-start-3");
  });

  it("keeps the outline sticky from 768 px and hides it below", () => {
    const html = render();
    expect(html).toContain("hidden md:col-start-2 md:row-start-1 md:block");
    expect(html).toMatch(/class="sticky pt-\[30px\]" style="top:100px"/);
  });

  it("folds sidenotes under their paragraph below 1280 px", () => {
    const notes = classOf(render(), 'role="note"');
    expect(notes).toContain("mt-4");
    expect(notes).toContain("border-t");
    expect(notes).toContain("xl:mt-0");
    expect(notes).toContain("xl:border-t-0");
  });

  it("switches Report | Sources below 768 px", () => {
    const html = render();
    expect(classOf(html, 'aria-label="Brief view"')).toContain("md:hidden");
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Report<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Sources<\/button>/);
    expect(html).toContain('data-tab="report"');
    // Report hides the notes, Sources hides the paragraphs and rows without notes.
    expect(classOf(html, 'role="note"')).toContain("max-md:group-data-[tab=report]/brief:hidden");
    expect(html).toContain("max-md:group-data-[tab=sources]/brief:hidden");
    expect(render("sources")).toContain('data-tab="sources"');
  });

  it("drops the mobile switch 56 px higher, under the running head only", () => {
    expect(classOf(render(), 'aria-label="Brief view"')).toBe(
      "sticky z-10 -mx-4 mb-6 flex gap-6 border-b border-line bg-paper px-4 md:hidden",
    );
    expect(render()).toMatch(/aria-label="Brief view"[^>]*style="top:44px"/);
  });
});

describe("RunningHead", () => {
  it("sits on the same tracks as the grid from 1280 px and sticks under the top bar", () => {
    const html = renderToStaticMarkup(
      <RunningHead desk="Investment" job="Competitors" question="Who competes with Juniper Cola?" finding="A crowded shelf" />,
    );
    const root = classOf(html, "h-11");
    expect(root).toContain(GRID_COLUMNS_XL);
    expect(root).toContain("sticky top-0 md:top-14");
    expect(html).toContain("Investment · Competitors");
    expect(html).toContain("Who competes with Juniper Cola?");
    expect(html).toContain("A crowded shelf");
  });
});
