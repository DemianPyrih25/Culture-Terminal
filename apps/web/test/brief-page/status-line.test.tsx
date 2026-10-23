// The status line on a phone: three lines are too tall to pin over the page, so one short line of the
// honesty line stays in view while the whole status line follows the page and covers it at the end.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HONESTY_LINE, HONESTY_SHORT, StatusLine } from "../../components/chrome";
import { events, render, slice, tagOf, text } from "./support";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("../../components/ask/top-bar-ask", () => ({ TopBarAsk: () => null }));

const classOf = (tag: string) => (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(" ");

describe("the status line below 768 px", () => {
  const html = renderToStaticMarkup(<StatusLine snapshot="6 Jul 2026" trendWindow="Jan–Jun 2026" requests={{ total: 12, cached: 5 }} />);

  it("pins one short line in view, drawn only: a screen reader hears the whole line once", () => {
    const strip = tagOf(html, "data-status-strip");
    expect(classOf(strip)).toEqual(expect.arrayContaining(["sticky", "bottom-0", "md:hidden", "truncate", "h-7"]));
    expect(strip).toContain('aria-hidden="true"');
    expect(text(slice(html, "data-status-strip", "</div>"))).toBe(HONESTY_SHORT);
    // It still says what matters: no advice, group-level data, no individuals.
    expect(HONESTY_SHORT).toMatch(/not financial advice/i);
    expect(HONESTY_SHORT).toContain("Group-level");
    expect(HONESTY_SHORT).toContain("No individuals");
  });

  it("lets the whole status line follow the page there, resting over the strip, and stick from 768 px", () => {
    const footer = classOf(tagOf(html, "<footer"));
    expect(footer).toEqual(expect.arrayContaining(["relative", "-mt-7", "md:sticky", "md:bottom-0", "md:mt-0"]));
    expect(footer).not.toContain("sticky");
    // After the strip, on the same layer, so at the end of the page it covers it.
    expect(html.indexOf("data-status-strip")).toBeLessThan(html.indexOf("<footer"));
    expect(text(slice(html, "<footer", "</footer>"))).toContain(`${HONESTY_LINE} · Snapshot 6 Jul 2026`);
  });

  it("draws no strip for a status line that does not stick, or whose own text has no short form", () => {
    const still = renderToStaticMarkup(<StatusLine sticky={false} />);
    expect(still).not.toContain("data-status-strip");
    expect(classOf(tagOf(still, "<footer"))).not.toContain("-mt-7");
    const custom = renderToStaticMarkup(<StatusLine left="Left text" />);
    expect(custom).not.toContain("data-status-strip");
    expect(classOf(tagOf(custom, "<footer"))).toContain("sticky");
  });

  it("pins the short line on the brief too, under its own honesty line", () => {
    const brief = render(events("brand-health")).html;
    expect(text(slice(brief, "data-status-strip", "</div>"))).toBe(HONESTY_SHORT);
  });
});
