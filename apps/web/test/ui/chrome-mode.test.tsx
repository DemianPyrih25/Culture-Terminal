// The mode on every page: the top bar mounts the replay-only banner right under itself, and the status
// line mounts the mode between the honesty line and its right-hand texts, and first in the phone strip,
// whatever a page passes. The real components read GET /api/access in the browser and render nothing
// on the server, so here they are stand-ins that render a mark (their own markup is tested in
// protection/protection-ui.test.tsx).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../components/protection/mode-status", () => ({
  ModeBanner: () => <div data-stand-in="mode-banner" />,
  ModeStatus: ({ short, className }: { short?: boolean; className?: string }) => (
    <span data-stand-in="mode-status" data-short={short ? "true" : undefined} className={className} />
  ),
}));

const { StatusLine, TopBar } = await import("../../components/chrome");

const count = (html: string, mark: string) => html.split(`data-stand-in="${mark}"`).length - 1;

describe("the top bar", () => {
  it("mounts the banner once, right under the bar", () => {
    const html = renderToStaticMarkup(<TopBar active="briefs" />);
    expect(count(html, "mode-banner")).toBe(1);
    expect(html.indexOf("</header>")).toBeLessThan(html.indexOf('data-stand-in="mode-banner"'));
    expect(html.endsWith('</header><div data-stand-in="mode-banner"></div>')).toBe(true);
  });

  it("leaves it out for a second bar on the same page", () => {
    expect(count(renderToStaticMarkup(<TopBar banner={false} />), "mode-banner")).toBe(0);
  });
});

describe("the status line", () => {
  it("mounts the mode between the honesty line and the right-hand texts, and its short word at the end of the phone strip", () => {
    const html = renderToStaticMarkup(<StatusLine snapshot="6 Jul 2026" trendWindow="Jan–Jun 2026" requests={{ total: 12, cached: 5 }} />);
    expect(count(html, "mode-status")).toBe(2);
    const strip = html.slice(html.indexOf("data-status-strip"), html.indexOf("</div>"));
    // The honesty line gives way first: it truncates, the mode's word does not.
    expect(strip).toBe(
      'data-status-strip="true"><span class="min-w-0 flex-1 truncate">Not financial advice · Group-level · No individuals</span>' +
        '<span data-stand-in="mode-status" data-short="true" class="shrink-0"></span>',
    );
    const footer = html.slice(html.indexOf("<footer"));
    const honesty = footer.indexOf("Snapshot 6 Jul 2026");
    const mode = footer.indexOf('data-stand-in="mode-status"');
    expect(honesty).toBeLessThan(mode);
    expect(mode).toBeLessThan(footer.indexOf("Trend window"));
    expect(footer).toContain('<span data-stand-in="mode-status" class="shrink-0"></span>');
  });

  it("keeps the mode when a page replaces the right-hand texts, or the whole line stays still", () => {
    expect(count(renderToStaticMarkup(<StatusLine right={<span>Qloo 87 / 1,900 req today</span>} />), "mode-status")).toBe(2);
    // No strip without sticking: the footer's mode alone.
    expect(count(renderToStaticMarkup(<StatusLine sticky={false} left="Left text" />), "mode-status")).toBe(1);
  });
});
