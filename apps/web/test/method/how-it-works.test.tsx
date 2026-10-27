// /how-it-works (N15): one h1, the three steps, how to read an answer with the trend window from the
// code, what we don't do, coverage and the data behind it, the link to /method and "Ask a question",
// in the new shell with How it works current. No examples and no Concept A remnants.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { decode } from "../figures/markup";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/how-it-works",
}));

const page = await import("../../app/how-it-works/page");
const { trendWindowText } = await import("../../app/method/facts");
const { DONT_BULLETS, DONT_CLOSING, HOW_NOTES, HOW_PAGE, HOW_STEPS, readingBullets } = await import("../../content/how-it-works");

const html = renderToStaticMarkup(<page.default />);
const text = decode(html);

describe("/how-it-works", () => {
  it("has its title and one h1, and is static", () => {
    expect(page.metadata.title).toBe("How it works · Culture Terminal");
    expect("dynamic" in page).toBe(false);
    expect(html.match(/<h1[^>]*>/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>How it works<\/h1>/);
    expect(text).toContain(HOW_PAGE.lead);
  });

  it("marks How it works current in the header", () => {
    const nav = html.match(/<a[^>]*data-nav="how"[^>]*>/)?.[0] ?? "";
    expect(nav).toContain('aria-current="page"');
  });

  it("shows the three steps, how to read an answer, what we don't do, coverage and the data", () => {
    expect(HOW_STEPS.map((s) => s.title)).toEqual(["You ask", "We measure", "We check"]);
    for (const step of HOW_STEPS) {
      expect(text).toContain(step.title);
      expect(text).toContain(step.text);
    }
    for (const bullet of readingBullets(trendWindowText())) expect(text).toContain(bullet);
    expect(text).toContain(`Qloo's latest trend window, ${trendWindowText()}.`);
    for (const bullet of DONT_BULLETS) expect(text).toContain(bullet);
    expect(text).toContain(DONT_CLOSING);
    for (const note of HOW_NOTES) {
      expect(text).toContain(note.title);
      expect(text).toContain(note.text);
    }
    expect(html.match(/<h2[^>]*>/g)).toHaveLength(HOW_STEPS.length + 2 + HOW_NOTES.length);
  });

  it("links to the analysts' reference and to a new question", () => {
    expect(html).toMatch(/<a[^>]*href="\/method"[^>]*>[\s\S]*?For analysts: every formula and rule/);
    expect(html).toMatch(/<a[^>]*href="\/#ask"[^>]*>[\s\S]*?Ask a question/);
  });

  it("carries no example and no Concept A remnant", () => {
    expect(text).not.toMatch(/example|showcase|Try:/i);
    expect(html).not.toMatch(/font-serif|text-dim|text-faint|rounded-brief|bg-paper/);
  });
});
