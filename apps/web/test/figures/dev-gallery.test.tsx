// /dev/figures is a development page: production answers 404, development shows every family.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import FiguresGallery from "../../app/dev/figures/page";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/dev/figures", () => {
  it("calls notFound in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => FiguresGallery()).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it("renders every figure in development, each with its own table toggle name", () => {
    vi.stubEnv("NODE_ENV", "development");
    const html = renderToStaticMarkup(<FiguresGallery />);
    for (let n = 1; n <= 44; n += 1) expect(html, `fig-${n}`).toContain(`id="fig-${n}"`);
    const toggles = [...html.matchAll(/role="radiogroup" aria-label="(View: [^"]+)"/g)].map((m) => m[1]);
    expect(toggles.length).toBeGreaterThan(10);
    expect(new Set(toggles).size).toBe(toggles.length);
    expect(html).toContain("no fee, availability or ROI data");
    // Every family, the LiftMap as its server schematic only.
    for (const marker of ['data-lift-map="austin"', "data-schematic=", 'data-axis="momentum"', 'data-badge="STALE"', 'data-axis="nashville"']) {
      expect(html).toContain(marker);
    }
    expect(html).not.toContain("maplibregl");
  });

  it("opens with the answer-page plots and both maps, from invented rows", () => {
    vi.stubEnv("NODE_ENV", "development");
    const html = renderToStaticMarkup(<FiguresGallery />);
    expect(html).toContain('data-plots-gallery="true"');
    for (const plot of ["bars", "diverging", "pair", "winners", "rank-tracks", "mini-bars", "ranked-fit", "slate", "numbered", "neighbours", "columns"]) {
      expect(html, plot).toContain(`data-plot="${plot}"`);
    }
    expect(html).toContain('data-map-card="austin"');
    expect(html).toContain('data-area-map="East Nashville"');
    expect(html).toContain("bg-hatch");
    expect(html.toLowerCase()).not.toContain("example");
  });
});
