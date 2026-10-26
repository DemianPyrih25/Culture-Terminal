// Card text (lib/og/text.ts): only characters the card fonts carry, so next/og never fetches a fallback
// font, and never an id (D29); and its widths (lib/og/measure.ts), so a label fits its slot whole or cut
// at a word. Characters outside the set are built from code points, never written raw.
import { describe, expect, it } from "vitest";
import charset from "../../lib/og/fonts/charset.json";
import { CARD_CODE_POINTS, cardLabel, cardText, fitWidth, inCardCharset, textWidth, truncate, type CardType } from "../../lib/og";
import { FAKE_UUID } from "./support";

const ch = (...codePoints: number[]) => String.fromCodePoint(...codePoints);

describe("cardText", () => {
  it("keeps Latin text, accents and the brief's punctuation as they are", () => {
    const text = "Café Łódź vs Brightwater Soda — who wins where? “Taste island” · 0.56 · ≤24 · −0.18 · 1.48× · Δ";
    expect(cardText(text)).toBe(text);
  });

  it("drops emoji, other scripts, control and zero-width characters, and collapses the space they leave", () => {
    const emoji = ch(0x1f964);
    const cjk = ch(0x30e6, 0x30cb);
    const zeroWidth = ch(0x200b);
    const control = ch(0x07);
    const bom = ch(0xfeff);
    expect(cardText(`Juniper ${emoji} Cola${zeroWidth} ${cjk} shoppers${control}?${bom}`)).toBe("Juniper Cola shoppers?");
  });

  it("turns every kind of space and line break into one space, and trims the ends", () => {
    expect(cardText(`  Who\tdrinks${ch(0xa0)}Kestrel${ch(0x2009)}Tonic\n\nnow? `)).toBe("Who drinks Kestrel Tonic now?");
  });

  it("spells out arrows the fonts lack", () => {
    expect(cardText("City → Site ← Block ≈ 2")).toBe("City to Site from Block ~ 2");
  });

  it("removes ids: UUIDs, URNs and long hex runs (D29)", () => {
    expect(cardText(`Brand ${FAKE_UUID} audience`)).toBe("Brand audience");
    expect(cardText("Tag urn:tag:genre:invented:rock fans")).toBe("Tag fans");
    expect(cardText("Request 0a1b2c3d4e5f60718293 done")).toBe("Request done");
    expect(cardText(null)).toBe("");
  });

  it("only ever returns characters of the card's set", () => {
    const sample = Array.from({ length: 0x3000 }, (_, i) => ch(i)).join("");
    for (const c of cardText(sample)) expect(inCardCharset(c.codePointAt(0)!)).toBe(true);
  });
});

describe("truncate", () => {
  it("returns text that fits unchanged", () => {
    expect(truncate("Which sponsors fit Marlowe Vance?", 40)).toBe("Which sponsors fit Marlowe Vance?");
  });

  it("cuts at the last word boundary, drops the punctuation before the cut and ends in an ellipsis", () => {
    const out = truncate("Where should a natural-wine and vinyl bar open, and which block suits it best?", 50);
    expect(out).toBe("Where should a natural-wine and vinyl bar open…");
    expect(out.length).toBeLessThanOrEqual(50);
  });

  it("cuts inside a single long word rather than dropping most of the text", () => {
    const out = truncate("Supercalifragilisticexpialidocious-brand", 12);
    expect(out).toBe("Supercalifr…");
  });

  it("fits labels to their slot after cleaning them", () => {
    expect(cardLabel(`  Harrow ${ch(0x1f37a)} Pale Lager  `, 30)).toBe("Harrow Pale Lager");
    expect(cardLabel("Cinder Hollow Rye Whiskey Company", 20)).toBe("Cinder Hollow Rye…");
  });
});

describe("the card's character set", () => {
  it("covers printable ASCII and leaves out control, format and zero-width characters", () => {
    for (let cp = 0x20; cp <= 0x7e; cp++) expect(inCardCharset(cp)).toBe(true);
    for (const cp of [0x00, 0x07, 0x1f, 0x7f, 0xad, 0x200b, 0x200d, 0x2028, 0x202e, 0x2060, 0xfeff]) expect(inCardCharset(cp)).toBe(false);
  });

  it("holds the capital of every character in it, as labels print in capitals (next/og would fetch a missing one)", () => {
    const missing = CARD_CODE_POINTS.flatMap((cp) =>
      [...String.fromCodePoint(cp).toUpperCase()].filter((c) => !inCardCharset(c.codePointAt(0)!)).map((c) => `${cp.toString(16)} -> ${c.codePointAt(0)!.toString(16)}`),
    );
    expect(missing).toEqual([]);
    // The micro sign is left out: its capital is the Greek letter.
    expect(inCardCharset(0xb5)).toBe(false);
    expect(cardText(`5 ${ch(0xb5)}g`)).toBe("5 g");
  });

  it("lists well-formed ranges in order", () => {
    let last = -1;
    for (const range of charset.ranges) {
      expect(range).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4})?$/);
      const [from = "", to = from] = range.split("-");
      expect(parseInt(from, 16)).toBeGreaterThan(last);
      expect(parseInt(to, 16)).toBeGreaterThanOrEqual(parseInt(from, 16));
      last = parseInt(to, 16);
    }
  });
});

describe("fitWidth", () => {
  const LABEL: CardType = { face: "sans-400", size: 14 };
  const CAPS: CardType = { face: "sans-600", size: 11, tracking: 1.3, upper: true };

  it("measures with the card fonts: capitals and letter spacing set wider", () => {
    expect(textWidth("vs peers", CAPS)).toBeGreaterThan(textWidth("vs peers", { ...CAPS, upper: false }));
    expect(textWidth("vs peers", CAPS)).toBeCloseTo(textWidth("vs peers", { ...CAPS, tracking: 0 }) + 8 * 1.3);
    expect(textWidth("", LABEL)).toBe(0);
    // Wide letters take more room than narrow ones.
    expect(textWidth("WWWW", LABEL)).toBeGreaterThan(2 * textWidth("iiii", LABEL));
  });

  it("returns a line that fits as it is", () => {
    expect(fitWidth("with Granite Outfitters", CAPS, 194, { segments: true })).toBe("with Granite Outfitters");
  });

  it("drops a comparator's trailing parts before it cuts a word", () => {
    expect(fitWidth("top half in 4 of 8 · vs peers", CAPS, 194, { segments: true })).toBe("top half in 4 of 8");
    expect(fitWidth("top half in 4 of 8 · vs peers", CAPS, 416, { segments: true })).toBe("top half in 4 of 8 · vs peers");
  });

  it("cuts a label at a word, its punctuation trimmed, and ends it in an ellipsis that fits", () => {
    const out = fitWidth("Top climber · Lantern Hi-Fi Bar", LABEL, 194);
    expect(out).toBe("Top climber · Lantern Hi-Fi…");
    expect(textWidth(out, LABEL)).toBeLessThanOrEqual(194);
    expect(fitWidth("Top climber · Lantern Hi-Fi Bar", LABEL, 110)).toBe("Top climber…");
  });

  it("cuts inside a word only when the first one alone is too wide", () => {
    const out = fitWidth("Supercalifragilisticexpialidocious", LABEL, 120);
    expect(out.endsWith("…")).toBe(true);
    expect("Supercalifragilisticexpialidocious".startsWith(out.slice(0, -1))).toBe(true);
    expect(textWidth(out, LABEL)).toBeLessThanOrEqual(120);
  });
});
