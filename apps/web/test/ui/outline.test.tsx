// The outline: ready sections are links, the forced item carries aria-current, and a section not written
// yet is a disabled link that says so.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Outline } from "../../components/layout/outline";

const ITEMS = [
  { id: "answer", label: "Answer" },
  { id: "conviction", label: "Conviction" },
  { id: "risks", label: "Risks", pending: true },
];

/** The outline entry whose text starts with `label`. */
function entry(html: string, label: string): string {
  const match = html.match(new RegExp(`<a[^>]*><span>${label}</span>.*?</a>`));
  if (!match) throw new Error(`no entry ${label}`);
  return match[0];
}

describe("Outline", () => {
  it("links each ready section and marks the active one", () => {
    const html = renderToStaticMarkup(<Outline items={ITEMS} activeId="conviction" />);
    expect(html).toContain('aria-label="On this brief"');
    expect(entry(html, "Answer")).toContain('href="#answer"');
    expect(entry(html, "Answer")).not.toContain("aria-current");
    expect(entry(html, "Conviction")).toContain('aria-current="location"');
    expect(entry(html, "Conviction")).toContain("border-accent");
  });

  it("announces a pending section as a disabled link, with no destination and no tab stop", () => {
    const risks = entry(renderToStaticMarkup(<Outline items={ITEMS} />), "Risks");
    expect(risks).toContain('role="link"');
    expect(risks).toContain('aria-disabled="true"');
    expect(risks).not.toContain("href=");
    expect(risks).not.toContain("tabindex");
    expect(risks).toContain('<span class="sr-only"> (not written yet)</span>');
    expect(risks).toContain("text-faint");
  });

  it("closes with the meta footer", () => {
    const html = renderToStaticMarkup(
      <Outline items={ITEMS} meta={{ trace: "Brief 0001 · 6 Jul 2026", text: "3 min read · 1 figure · 12 sources" }} />,
    );
    expect(html).toContain("Brief 0001 · 6 Jul 2026");
    expect(html).toContain("3 min read · 1 figure · 12 sources");
  });
});
