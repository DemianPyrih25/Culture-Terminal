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
    for (let n = 1; n <= 18; n += 1) expect(html, `fig-${n}`).toContain(`id="fig-${n}"`);
    const toggles = [...html.matchAll(/aria-label="(Table view: [^"]+)"/g)].map((m) => m[1]);
    expect(toggles.length).toBeGreaterThan(10);
    expect(new Set(toggles).size).toBe(toggles.length);
    expect(html).toContain("no fee, availability or ROI data");
  });
});
