// The top bar: wordmark home link, the active underline, and sections without a page shown disabled.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusLine } from "../../components/chrome/status-line";
import { NAV_ENABLED, TopBar } from "../../components/chrome/top-bar";

function navTag(html: string, key: string): string {
  const match = html.match(new RegExp(`<a[^>]*data-nav="${key}"[^>]*>`));
  if (!match) throw new Error(`no nav item ${key}`);
  return match[0];
}

/** The whole nav item, opening tag to closing tag. */
function navItem(html: string, key: string): string {
  const match = html.match(new RegExp(`<a[^>]*data-nav="${key}"[^>]*>.*?</a>`));
  if (!match) throw new Error(`no nav item ${key}`);
  return match[0];
}

describe("TopBar", () => {
  it("links the wordmark home and renders the command slot", () => {
    const html = renderToStaticMarkup(<TopBar command={<input aria-label="Ask" />} />);
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>Culture Terminal<\/a>/);
    expect(html).toContain('aria-label="Ask"');
    expect(html).toContain('aria-label="Main"');
  });

  it("renders Following and Method disabled until their parts exist", () => {
    expect(NAV_ENABLED).toEqual({ briefs: true, following: false, method: false });
    const html = renderToStaticMarkup(<TopBar active="briefs" />);
    for (const key of ["following", "method"]) {
      const tag = navTag(html, key);
      // A disabled link to assistive technology: the link role, aria-disabled, no destination, no tab stop.
      expect(tag).toContain('role="link"');
      expect(tag).toContain('aria-disabled="true"');
      expect(tag).not.toContain("href=");
      expect(tag).not.toContain("tabindex");
      expect(tag).toContain("text-faint");
      // And the reason, spoken: the title alone never reaches keyboard or screen-reader users.
      expect(navItem(html, key)).toContain('<span class="sr-only"> (not available yet)</span>');
    }
    const briefs = navTag(html, "briefs");
    expect(briefs).toContain('href="/briefs"');
    expect(briefs).not.toContain("aria-disabled");
    expect(briefs).not.toContain('role="link"');
    expect(navItem(html, "briefs")).not.toContain("not available");
  });

  it("marks the active section with aria-current and the accent underline", () => {
    const html = renderToStaticMarkup(<TopBar active="briefs" enabled={{ method: true }} />);
    const briefs = navTag(html, "briefs");
    expect(briefs).toContain('aria-current="page"');
    expect(briefs).toContain("border-accent");
    const method = navTag(html, "method");
    expect(method).toContain('href="/method"');
    expect(method).not.toContain("aria-current");
    expect(method).toContain("border-transparent");
  });

  it("has no avatar: there are no accounts", () => {
    const html = renderToStaticMarkup(<TopBar />);
    expect(html).not.toMatch(/avatar|monogram/i);
  });
});

describe("StatusLine", () => {
  it("defaults to the honesty line with the snapshot, the trend window and the request count", () => {
    const html = renderToStaticMarkup(
      <StatusLine snapshot="6 Jul 2026" trendWindow="Jan–Jun 2026" requests={{ total: 12, cached: 5 }} />,
    );
    expect(html).toContain(
      "Analytics, not financial advice · Group-level taste data · No individuals · Snapshot 6 Jul 2026",
    );
    expect(html).toContain("Trend window Jan–Jun 2026");
    expect(html).toContain("Qloo 12 req · 5 cached");
  });

  it("takes custom slots", () => {
    const html = renderToStaticMarkup(<StatusLine left="Left text" right={<span>Right text</span>} />);
    expect(html).toContain("Left text");
    expect(html).toContain("Right text");
    expect(html).not.toContain("financial advice");
  });
});
