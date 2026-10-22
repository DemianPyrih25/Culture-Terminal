// Untrusted Qloo text (§4.6): what safeText lets through to labels, findings and digests.
import { describe, expect, it } from "vitest";
import { FULL_NAME_MAX, NAME_MAX, safeFullName, safeName, safeText } from "../../src/skills/format";

describe("safeText", () => {
  it("removes bidirectional overrides and isolates, so a name cannot render reordered", () => {
    expect(safeText("Brand \u202eahplA\u202c Cola")).toBe("Brand ahplA Cola");
    expect(safeText("\u2066Brand Beta\u2069 \u200fsoda\u200e")).toBe("Brand Beta soda");
  });

  it("removes zero-width marks, word joiners, the BOM, separators and tag characters", () => {
    expect(safeText("Brand\u200b Gamma\u200d\u2060\ufeff")).toBe("Brand Gamma");
    expect(safeText("Brand Delta\u2028second line\u2029")).toBe("Brand Delta second line");
    expect(safeText("Brand Epsilon\u{e0049}\u{e0067}\u{e006e}")).toBe("Brand Epsilon");
  });

  it("still removes control characters and links and collapses whitespace", () => {
    expect(safeText("Brand\u0007  Zeta\n see https://example.test/x")).toBe("Brand Zeta see [link]");
  });

  it("never cuts through a surrogate pair", () => {
    const cut = safeText(`${"a".repeat(8)}\u{1f600}tail`, 10);
    expect(cut).toBe(`${"a".repeat(8)}…`);
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(safeText(`${"a".repeat(7)}\u{1f600}tail`, 10)).toBe(`${"a".repeat(7)}\u{1f600}…`);
  });
});

describe("safeName and safeFullName", () => {
  const long = `Brand Alpha ${"Extended Heritage Trading ".repeat(4)}`.trim();

  it("cuts names for the model and keeps them whole for the reader's grid, cleaning both", () => {
    expect(safeName(long)).toHaveLength(NAME_MAX);
    expect(safeFullName(long)).toBe(long);
    expect(safeFullName(`${long}\u202e`)).toBe(long);
    expect(safeFullName("x".repeat(200))).toHaveLength(FULL_NAME_MAX);
  });
});
