// The share card's fonts (lib/og/fonts.ts): read from lib/og/fonts, never fetched, and every character
// the card may print has a glyph in every face, so next/og never reaches for a fallback font.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import charset from "../../lib/og/fonts/charset.json";
import metrics from "../../lib/og/fonts/metrics.json";
import { CARD_CODE_POINTS, OG_FONT } from "../../lib/og";
import { ogFontDirs, ogFonts } from "../../lib/og/fonts";
import { FONT_DIR, fontAdvances, fontCodePoints } from "./support";

vi.mock("server-only", () => ({}));

const CARD_FACES = ["card-sans-400.woff", "card-sans-600.woff", "card-serif-500.woff", "card-serif-600.woff"];
const MONO = "ibm-plex-mono-latin-400-normal.woff";

const charsetCodePoints = (): number[] =>
  charset.ranges.flatMap((range) => {
    const [from = "", to = from] = range.split("-");
    return Array.from({ length: parseInt(to, 16) - parseInt(from, 16) + 1 }, (_, i) => parseInt(from, 16) + i);
  });

describe("the card fonts", () => {
  it("are the five faces the card sets, with each source's licence beside them", () => {
    const files = readdirSync(FONT_DIR);
    expect(files).toEqual(expect.arrayContaining([...CARD_FACES, MONO, "OFL-Inter.txt", "OFL-SourceSerif4.txt", "OFL-IBMPlexMono.txt"]));
    // WOFF 1.0 only: next/og cannot read WOFF2, and the repository guard reads no TTF.
    for (const f of files.filter((f) => /\.(ttf|otf|woff2)$/.test(f))) throw new Error(`unexpected font format: ${f}`);
  });

  it("load for ImageResponse from the app's folder or the repository root, read once", async () => {
    expect(ogFontDirs("/app/apps/web")[0]).toMatch(/lib[\\/]og[\\/]fonts$/);
    const fonts = await ogFonts();
    expect(fonts.map((f) => `${f.name} ${f.weight}`)).toEqual([
      `${OG_FONT.sans} 400`,
      `${OG_FONT.sans} 600`,
      `${OG_FONT.serif} 500`,
      `${OG_FONT.serif} 600`,
      `${OG_FONT.mono} 400`,
    ]);
    for (const f of fonts) {
      expect(f.style).toBe("normal");
      expect(new TextDecoder().decode(new Uint8Array(f.data).slice(0, 4))).toBe("wOFF");
    }
    expect(await ogFonts()).toBe(fonts);
  });

  it.each(CARD_FACES)("%s has a glyph for every character of the card's set", (file) => {
    const mapped = fontCodePoints(file);
    const missing = charsetCodePoints().filter((cp) => !mapped.has(cp));
    expect(missing.map((cp) => cp.toString(16))).toEqual([]);
  });

  it.each([
    ["sans-400", "card-sans-400.woff"],
    ["sans-600", "card-sans-600.woff"],
  ] as const)("keep %s's advance widths in metrics.json, in the order of the card's set", (face, file) => {
    const font = fontAdvances(file);
    expect(metrics.faces[face].unitsPerEm).toBe(font.unitsPerEm);
    expect(metrics.faces[face].advances).toEqual(CARD_CODE_POINTS.map((cp) => font.advances.get(cp)));
  });

  it("carry each instance's licence under the copyright notice of the font it was cut from", () => {
    const licence = (file: string) => readFileSync(path.join(FONT_DIR, file), "utf8");
    // Source Serif 4 is Adobe's, and its reserved name is why the instance is called CT Card Serif.
    expect(licence("OFL-SourceSerif4.txt")).toMatch(/^© 2014 - 2021 Adobe Systems Incorporated .*Reserved Font Name .Source./);
    expect(licence("OFL-Inter.txt")).toMatch(/^Copyright 2016 The Inter Project Authors/);
    expect(licence("OFL-IBMPlexMono.txt")).toMatch(/^Copyright 2017 IBM Corp./);
    for (const file of ["OFL-SourceSerif4.txt", "OFL-Inter.txt", "OFL-IBMPlexMono.txt"]) expect(licence(file)).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  it("give the receipt strip's mono every character it prints", () => {
    const mono = fontCodePoints(MONO);
    for (const c of "Qloo 21 req · 5 cached 25/25 numbers traced Not checked LLM <$0.01 $0.10") expect(mono.has(c.codePointAt(0)!)).toBe(true);
  });
});
