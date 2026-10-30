// The answer's prose keeps punctuation that touches a metric on the metric's line: a number never wraps
// inside, so "(" before it or ")" after it would otherwise sit alone at a line's end or start on a phone.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AnswerProse } from "../../components/answer/answer-prose";
import type { Inline, MetricView } from "../../lib/brief";

vi.mock("server-only", () => ({}));

const metric = (id: string, text: string) => ({ id, text, unavailable: false, reason: null }) as unknown as MetricView;

describe("punctuation next to a metric", () => {
  it("wraps the opening and closing brackets with the number, and prints every character once", () => {
    const inlines: Inline[] = [
      { kind: "text", text: "Ranks first (" },
      { kind: "metric", metric: metric("M1", "1 of 13 cities"), footnote: 1 },
      { kind: "text", text: "); the rest trail." },
    ];
    const html = renderToStaticMarkup(<AnswerProse inlines={inlines} />);
    expect(html).toContain('<span class="whitespace-nowrap">(<span data-metric="M1" class="tabular-nums">1 of 13 cities</span>);</span>');
    expect(html.replace(/<[^>]+>/g, "")).toBe("Ranks first (1 of 13 cities); the rest trail.");
  });

  it("leaves a metric between plain words as it was, and shares a quote between two metrics once", () => {
    const plain = renderToStaticMarkup(
      <AnswerProse inlines={[{ kind: "text", text: "Lift " }, { kind: "metric", metric: metric("M2", "1.4×"), footnote: 1 }, { kind: "text", text: " here" }]} />,
    );
    expect(plain).not.toContain("whitespace-nowrap");
    const shared = renderToStaticMarkup(
      <AnswerProse
        inlines={[
          { kind: "metric", metric: metric("M3", "a"), footnote: 1 },
          { kind: "text", text: '"' },
          { kind: "metric", metric: metric("M4", "b"), footnote: 2 },
        ]}
      />,
    );
    expect(shared.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"')).toBe('a"b');
  });
});
