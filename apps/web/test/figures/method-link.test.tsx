// /method is built (Part 7, ROUTE_LIVE.method): a figure's ⓘ link opens its formula's entry there.
import { describe, expect, it } from "vitest";
import { FigureFrame, methodHref } from "../../components/figures";
import { FIXTURE_SOURCES } from "../../components/figures/fixtures";
import { ROUTE_LIVE } from "../../lib/routes";
import { render } from "./markup";

describe("the figure method link", () => {
  it("opens the formula's entry on /method", () => {
    expect(ROUTE_LIVE.method).toBe(true);
    const html = render(
      <FigureFrame
        meta={{ title: "A finding", caption: "A caption.", source: FIXTURE_SOURCES.insights, formulaId: "share.pct" }}
        plot={<svg role="img" aria-label="A finding" />}
        table={<table />}
      />,
    );
    expect(methodHref("share.pct")).toBe("/method#share.pct");
    expect(html).toContain('href="/method#share.pct"');
    expect(html).toContain("How it&#x27;s calculated");
  });
});
