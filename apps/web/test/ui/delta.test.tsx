// Delta always names its comparator and never draws UNAVAILABLE as 0 (PLAN §8.3).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Delta, deltaDirection, formatDelta } from "../../components/ui/delta";

describe("Delta", () => {
  it("prints the arrow, the signed value and the comparator", () => {
    const over = renderToStaticMarkup(<Delta value={0.27} comparator="vs category median" />);
    expect(over).toContain('data-direction="over"');
    expect(over).toContain("▲");
    expect(over).toContain("+0.27");
    expect(over).toContain("vs category median");
    expect(over).toContain("text-accent");

    const under = renderToStaticMarkup(<Delta value={-0.12} comparator="vs city" />);
    expect(under).toContain('data-direction="under"');
    expect(under).toContain("▼");
    expect(under).toContain("−0.12");
    expect(under).toContain("vs city");
    expect(under).toContain("text-negative");
  });

  it("refuses to render without a comparator", () => {
    expect(() => renderToStaticMarkup(<Delta value={0.27} comparator="" />)).toThrow(/comparator is required/);
    expect(() => renderToStaticMarkup(<Delta value={0.27} comparator="   " />)).toThrow(/comparator is required/);
  });

  it("renders an unavailable value as text, with no arrow and no zero", () => {
    const html = renderToStaticMarkup(<Delta value={null} comparator="vs peers" />);
    expect(html).toContain('data-direction="unavailable"');
    expect(html).toContain("Unavailable");
    expect(html).toContain("vs peers");
    expect(html).not.toMatch(/[▲▼]/);
    expect(html).not.toMatch(/>[+−]?0(\.0+)?</);
  });

  it("keeps a display override and the comparator together", () => {
    const html = renderToStaticMarkup(<Delta value={2} display="+2 places" comparator="vs last window" />);
    expect(html).toContain("+2 places");
    expect(html).toContain("vs last window");
  });
});

describe("deltaDirection and formatDelta", () => {
  it("reads the direction from the sign", () => {
    expect(deltaDirection(0.35)).toBe("over");
    expect(deltaDirection(-0.35)).toBe("under");
    expect(deltaDirection(0)).toBe("flat");
    expect(deltaDirection(null)).toBe("unavailable");
    expect(deltaDirection(Number.NaN)).toBe("unavailable");
  });

  it("signs with a plus or a true minus, and leaves zero unsigned", () => {
    expect(formatDelta(0.274)).toBe("+0.27");
    expect(formatDelta(-0.123)).toBe("−0.12");
    expect(formatDelta(-0.001)).toBe("0.00");
    expect(formatDelta(3, 0)).toBe("+3");
  });
});
