// The answer page (components/answer) as the server's first paint prints it, from the synthetic runs of
// the /dev/brief viewer (invented entities, D29): the page head, the cards in the design's order, Source on
// every key number and chart, the How we know openers, and no example or showcase anywhere.
import { describe, expect, it, vi } from "vitest";
import { Job, type RunEvent } from "@ct/contracts";
import { ghostRunEvents } from "../../app/dev/brief/ghost-runs";
import { jobRunEvents } from "../../app/dev/brief/job-runs";
import { variantEvents } from "../../app/dev/brief/variants";
import { attrValues, render, slice, text } from "../brief-page/support";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), usePathname: () => "/r/x" }));

const page = (events: readonly RunEvent[]) => render(events).html;
const brand = page(ghostRunEvents("brand_health") ?? []);

/** Where a marker first appears, to check the order of the cards. */
const at = (html: string, marker: string) => {
  const i = html.indexOf(marker);
  if (i < 0) throw new Error(`no ${marker}`);
  return i;
};

describe("the answer page", () => {
  it("has one h1, the question, under the page head's eyebrow", () => {
    expect(brand.match(/<h1\b/g)).toHaveLength(1);
    expect(text(slice(brand, "<h1", "</h1>"))).toBe("Is the Juniper Cola audience a moat or a niche?");
    expect(text(brand)).toContain("Brands & investing · Real competitors · Data as of 21 Oct 2026");
  });

  it("prints the cards in the design's order", () => {
    const order = [
      'data-verdict="answer"',
      "Next steps",
      'data-key-numbers="3"',
      "Closest audiences",
      "We guessed, then checked",
      'data-ghost="competitors"',
      "What could change this",
      "Why we think this",
      "More charts",
      "Ask next",
    ].map((m) => at(brand, m));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("says the verdict with its period, the confidence, the advice line and the check", () => {
    const verdict = text(slice(brand, 'data-verdict="answer"', "Next steps"));
    expect(verdict).toContain("Taste island.");
    expect(verdict).toContain("High confidence");
    expect(verdict).toContain("Taste signals, not buy or sell advice.");
    expect(verdict).toContain("All 4 numbers checked against Qloo data");
  });

  it("opens How we know from every key number and chart, and the head", () => {
    expect(attrValues(brand, "aria-label").filter((l) => l.startsWith("Source of"))).toEqual(
      expect.arrayContaining(["Source of Closest audience", "Source of Most distinctive fans", "Source of Age lean", "Source of Last in most peer rows"]),
    );
    expect(text(brand)).toContain("How we know");
    // A metric in the headline and the guesses opens its number too.
    expect(brand).toContain('aria-label="0.56: how we know this number"');
  });

  it("draws the main chart with its table view, and lists the other figures under More charts", () => {
    expect(brand).toContain('data-plot="bars"');
    expect(text(brand)).toContain("1.00 = identical tastes. Shared taste, not shared customers.");
    expect(attrValues(brand, "data-more-chart")).toEqual(["D3", "D2"]);
  });

  it("asks next with the run's own moves and a follow-up field about the subject", () => {
    expect(attrValues(brand, "data-next-move")).toEqual(["Who they are", "Head to head", "Launch cities"]);
    expect(brand).toContain('placeholder="Ask a follow-up about Juniper Cola"');
    expect(brand).toContain(`href="/ask?q=${encodeURIComponent("Who is the Juniper Cola audience beyond beverages?").replace(/%20/g, "+")}`);
  });

  it("keeps the phone header's back, share and menu, and the replay in the menu", () => {
    expect(brand).toContain('aria-label="Back"');
    expect(brand).toContain('aria-label="Share"');
    expect(brand).toContain('aria-label="Menu"');
  });

  it.each(Job.options)("%s: renders, with no example or showcase words and nothing from the old brief", (job) => {
    const html = page(jobRunEvents(job));
    expect(html).toContain(`data-answer="${job}"`);
    expect(text(html)).not.toMatch(/\bexamples?\b|showcase|Try:/i);
    expect(html).not.toMatch(/font-serif|text-dim|rounded-brief|bg-paper|data-marker="UNLISTED"/);
  });

  it("says at the top, before the verdict, which job a question was read as and what is not covered (D41)", () => {
    const html = page(jobRunEvents("launch_test"));
    expect(at(html, 'data-read-as="true"')).toBeLessThan(at(html, 'data-verdict="answer"'));
    const note = text(slice(html, 'data-read-as="true"', 'data-verdict="answer"'));
    expect(note).toContain("Read as: Test a new product");
    expect(note).toContain("Not covered: pricing.");
    expect(page(jobRunEvents("brand_health"))).not.toContain("data-read-as");
  });

  it("draws a concept check with dropped guesses struck through and never linked, and public figures as tables", () => {
    const html = page(jobRunEvents("launch_test"));
    expect(html).toContain('data-plot="verdicts"');
    const dropped = slice(html, 'data-verdict="veto"', "</section>");
    expect(dropped).toContain("line-through");
    expect(dropped).not.toContain("href=");
    expect(html).toContain('data-plot="rows"');
    expect(text(html)).toContain("10-K filed 2026-02-19");
    const twins = page(jobRunEvents("taste_twins"));
    expect(twins).toContain('data-comparison="true"');
    expect(text(twins)).toContain("All 4 numbers checked against Qloo and Census data");
  });

  it("says when there is not enough data, with the plain chip", () => {
    const html = page(variantEvents(jobRunEvents("brand_health"), "notenough"));
    expect(html).toContain('data-verdict="not_enough"');
    expect(text(html)).toContain("Not enough data to call this");
    expect(text(html)).toContain("Here's what we found.");
    expect(html).toContain('data-confidence="insufficient_evidence"');
  });
});
