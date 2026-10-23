// Until /method ships (Part 7, ROUTE_LIVE.method), a figure prints no ⓘ link: a reader never lands on a 404.
import { describe, expect, it } from "vitest";
import { FigureFrame } from "../../components/figures";
import { FIXTURE_SOURCES } from "../../components/figures/fixtures";
import { ROUTE_LIVE } from "../../lib/routes";
import { render } from "./markup";

describe("the figure method link before /method exists", () => {
  it("is left out while the method page is not built", () => {
    expect(ROUTE_LIVE.method).toBe(false);
    const html = render(
      <FigureFrame
        meta={{ number: 1, title: "A finding", caption: "A caption.", source: FIXTURE_SOURCES.insights, formulaId: "share.pct" }}
        plot={<svg role="img" aria-label="A finding" />}
        table={<table />}
      />,
    );
    expect(html).not.toContain("/method");
    expect(html).toContain(">FIGURE 1<");
  });
});
