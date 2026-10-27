// /dev/ui is a development page: production answers 404. In development it shows the foundations and
// every primitive of the component library.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import UiKitPage from "../../app/dev/ui/page";
import { ICON_NAMES } from "../../components/ui/icons";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/dev/ui", () => {
  it("calls notFound in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => UiKitPage()).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it("renders the foundations and every primitive in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    const html = renderToStaticMarkup(<UiKitPage />);
    for (const marker of [
      "Foundations",
      "Components",
      "accent-ink",
      "topic-audiences",
      "mono-4",
      "type-display-xl",
      "shadow-lg",
      // Header, footer, page head
      'aria-label="Main"',
      "Your answers",
      "New question",
      "Group-level taste data from Qloo",
      'aria-label="Back"',
      // Buttons, chips, tags, tiles, monograms
      "Get answer",
      "Reading…",
      "Copy id",
      "Edit question",
      'aria-pressed="true"',
      "Hidden gem",
      "Few rivals nearby",
      "Sponsors &amp; tours",
      'data-palette="mono-2"',
      // Confidence, segmented, inline states, key numbers, chart card, toast
      "Medium confidence",
      "Not enough data",
      "Full breakdown in How we know",
      'role="radiogroup"',
      'role="tablist"',
      'data-tone="danger"',
      "Live updates stopped",
      'data-variant="split"',
      'data-draft="true"',
      'data-selected="true"',
      "1.00 = identical tastes",
      "Link copied",
      "No data after Sep 2025",
      "How we know",
    ]) {
      expect(html, marker).toContain(marker);
    }
    for (const name of ICON_NAMES) expect(html, name).toContain(`data-icon="${name}"`);
  });

  it("shows no example cards or example links", () => {
    vi.stubEnv("NODE_ENV", "development");
    const html = renderToStaticMarkup(<UiKitPage />);
    expect(html).not.toMatch(/examples/i);
  });
});
