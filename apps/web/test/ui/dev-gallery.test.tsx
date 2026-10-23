// /dev/ui is a development page: production answers 404.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import UiKitPage from "../../app/dev/ui/page";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/dev/ui", () => {
  it("calls notFound in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => UiKitPage()).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it("renders every kit component in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    const html = renderToStaticMarkup(<UiKitPage />);
    for (const marker of [
      "Culture Terminal",
      'aria-label="Main"',
      "Which brands sit closest to Juniper Cola?",
      "Analytics, not financial advice",
      "<kbd",
      'role="search"',
      'aria-label="On this brief"',
      'aria-label="On this page"',
      'data-direction="unavailable"',
      'role="meter"',
      'role="radiogroup"',
      'aria-haspopup="dialog"',
      'type="checkbox"',
      'type="search"',
      "<select",
      "No signal after Jun 2026",
      'aria-label="Brief view"',
      // The library's key map: ⌘K on the top bar's field, / on Search briefs.
      'aria-keyshortcuts="Meta+K Control+K"',
      'aria-keyshortcuts="/"',
    ]) {
      expect(html, marker).toContain(marker);
    }
  });

  it("binds each key once", () => {
    vi.stubEnv("NODE_ENV", "development");
    const html = renderToStaticMarkup(<UiKitPage />);
    expect(html.match(/aria-keyshortcuts="[^"]*Control\+K/g)).toHaveLength(1);
    expect(html.match(/aria-keyshortcuts="[^"]*\/"/g)).toHaveLength(1);
  });
});
