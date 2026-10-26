// Builds the share card's fonts (lib/og/fonts.ts) from the font files the app already ships: next/og
// reads TTF, OTF and WOFF but not the app's variable WOFF2, and it draws a variable font at its
// default weight only. So this writes static WOFF 1.0 instances of Inter and Source Serif 4 at the
// card's weights, cut to charset.json (latin, latin-ext and Δ; ≤ and ≥ drawn from < > =), with the
// pair kerning of the source; IBM Plex Mono is copied as published. Each source's licence goes next
// to its fonts (SIL OFL 1.1): an instance's carries the copyright notice of the font it was cut from,
// as the package's own file names another holder. The instances carry their own family names: Source
// Serif 4 reserves the name "Source" for unmodified versions. metrics.json keeps the sans faces'
// advance widths, which lib/og/measure.ts fits labels to their slots with.
//
// Run from the repository root: node apps/web/lib/og/fonts/build-fonts.mjs
// fontkit comes with mapshaper, a root devDependency. The output is byte-for-byte reproducible.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../../..");
const fontkit = createRequire(createRequire(path.join(root, "package.json")).resolve("mapshaper"))("fontkit");
const modules = path.join(root, "apps/web/node_modules");

const INTER = path.join(modules, "@fontsource-variable/inter");
const SERIF = path.join(modules, "@fontsource-variable/source-serif-4");
const MONO = path.join(modules, "@fontsource/ibm-plex-mono");

/**
 * The faces the card sets (lib/og/fonts.ts), from the same files the app loads in app/layout.tsx.
 * `metrics` names a face whose advance widths go to metrics.json.
 */
const FACES = [
  { out: "card-sans-400.woff", family: "CT Card Sans", weight: 400, pkg: INTER, files: ["inter-latin-wght-normal.woff2", "inter-latin-ext-wght-normal.woff2", "inter-greek-wght-normal.woff2"], metrics: "sans-400" },
  { out: "card-sans-600.woff", family: "CT Card Sans", weight: 600, pkg: INTER, files: ["inter-latin-wght-normal.woff2", "inter-latin-ext-wght-normal.woff2", "inter-greek-wght-normal.woff2"], metrics: "sans-600" },
  { out: "card-serif-500.woff", family: "CT Card Serif", weight: 500, pkg: SERIF, files: ["source-serif-4-latin-wght-normal.woff2", "source-serif-4-latin-ext-wght-normal.woff2", "source-serif-4-greek-wght-normal.woff2"] },
  { out: "card-serif-600.woff", family: "CT Card Serif", weight: 600, pkg: SERIF, files: ["source-serif-4-latin-wght-normal.woff2", "source-serif-4-latin-ext-wght-normal.woff2", "source-serif-4-greek-wght-normal.woff2"] },
];
/** Copied as published: Plex Mono is not modified, and its package's licence names its holder. */
const COPIES = [
  { from: path.join(MONO, "files/ibm-plex-mono-latin-400-normal.woff"), to: "ibm-plex-mono-latin-400-normal.woff" },
  { from: path.join(MONO, "LICENSE"), to: "OFL-IBMPlexMono.txt" },
];
/** The instances' licences: the package's OFL text under the copyright notice of the font cut from. */
const LICENCES = [
  { pkg: INTER, font: "inter-latin-wght-normal.woff2", to: "OFL-Inter.txt" },
  { pkg: SERIF, font: "source-serif-4-latin-wght-normal.woff2", to: "OFL-SourceSerif4.txt" },
];
const OFL_START = "This Font Software is licensed under";

/**
 * Signs the published subsets leave out, drawn from glyphs they keep: ≤ and ≥ as < and > raised over
 * the lower bar of =. Brief labels use them ("≤24", an age group).
 */
const SYNTHETIC = new Map([
  [0x2264, 0x3c],
  [0x2265, 0x3e],
]);

/** Kerning pairs are taken among these (letters, digits, punctuation, quotes), first file only. */
const KERNED = (cp) => (cp >= 0x21 && cp <= 0x7e) || (cp >= 0xc0 && cp <= 0xff && cp !== 0xd7 && cp !== 0xf7) || (cp >= 0x2018 && cp <= 0x201d);
/** A format-0 kern subtable holds at most this many pairs (its length is 16-bit). */
const MAX_PAIRS = 10_900;
const NO_LIGATURES = { liga: false, clig: false, calt: false, dlig: false, rlig: false };

function codePoints() {
  const { ranges } = JSON.parse(readFileSync(path.join(here, "charset.json"), "utf8"));
  const out = [];
  for (const range of ranges) {
    const [from, to = from] = range.split("-").map((h) => parseInt(h, 16));
    for (let cp = from; cp <= to; cp++) out.push(cp);
  }
  return out;
}

// Binary helpers -----------------------------------------------------------------------------------

class Writer {
  constructor() {
    this.bytes = [];
  }
  u8(v) {
    this.bytes.push(v & 0xff);
  }
  u16(v) {
    this.u8(v >> 8);
    this.u8(v);
  }
  i16(v) {
    this.u16(v < 0 ? v + 0x10000 : v);
  }
  u32(v) {
    this.u16(Math.floor(v / 0x10000) & 0xffff);
    this.u16(v & 0xffff);
  }
  tag(s) {
    for (const ch of s.padEnd(4, " ").slice(0, 4)) this.u8(ch.charCodeAt(0));
  }
  raw(buf) {
    for (const b of buf) this.u8(b);
  }
  buffer() {
    return Buffer.from(this.bytes);
  }
}

const align4 = (n) => (n + 3) & ~3;

function checksum(buf) {
  const padded = Buffer.alloc(align4(buf.length));
  buf.copy(padded);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

/** searchRange, entrySelector, rangeShift for a binary-searched array of `n` items of `size` bytes. */
function searchParams(n, size) {
  let power = 1;
  let log = 0;
  while (power * 2 <= n) {
    power *= 2;
    log++;
  }
  return [power * size, log, n * size - power * size];
}

// Glyphs -------------------------------------------------------------------------------------------

/** A glyph's outline as TrueType contours of rounded points, from fontkit's path at the instance. */
function contoursOf(glyph) {
  const contours = [];
  let current = null;
  const point = (x, y, on) => {
    const p = { x: Math.round(x), y: Math.round(y), on };
    const last = current.at(-1);
    if (on && last && last.on && last.x === p.x && last.y === p.y) return;
    current.push(p);
  };
  for (const c of glyph.path.commands) {
    if (c.command === "moveTo") {
      current = [];
      contours.push(current);
      point(c.args[0], c.args[1], true);
    } else if (c.command === "lineTo") {
      point(c.args[0], c.args[1], true);
    } else if (c.command === "quadraticCurveTo") {
      point(c.args[0], c.args[1], false);
      point(c.args[2], c.args[3], true);
    } else if (c.command !== "closePath") {
      throw new Error(`unexpected ${c.command} in glyph ${glyph.id}: the source is not a TrueType outline`);
    }
  }
  for (const c of contours) {
    while (c.length > 1 && c.at(-1).on && c[0].on && c.at(-1).x === c[0].x && c.at(-1).y === c[0].y) c.pop();
  }
  return contours.filter((c) => c.length >= 3);
}

function encodeGlyph(contours) {
  if (contours.length === 0) return { data: Buffer.alloc(0), bbox: null, points: 0, contours: 0 };
  const points = contours.flat();
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const bbox = { xMin: Math.min(...xs), yMin: Math.min(...ys), xMax: Math.max(...xs), yMax: Math.max(...ys) };
  const w = new Writer();
  w.i16(contours.length);
  w.i16(bbox.xMin);
  w.i16(bbox.yMin);
  w.i16(bbox.xMax);
  w.i16(bbox.yMax);
  let end = -1;
  for (const c of contours) w.u16((end += c.length));
  w.u16(0); // no instructions
  const flags = [];
  const xBytes = new Writer();
  const yBytes = new Writer();
  let lastX = 0;
  let lastY = 0;
  for (const p of points) {
    let flag = p.on ? 0x01 : 0;
    const dx = p.x - lastX;
    const dy = p.y - lastY;
    if (dx === 0) flag |= 0x10;
    else if (Math.abs(dx) <= 255) {
      flag |= 0x02 | (dx > 0 ? 0x10 : 0);
      xBytes.u8(Math.abs(dx));
    } else xBytes.i16(dx);
    if (dy === 0) flag |= 0x20;
    else if (Math.abs(dy) <= 255) {
      flag |= 0x04 | (dy > 0 ? 0x20 : 0);
      yBytes.u8(Math.abs(dy));
    } else yBytes.i16(dy);
    flags.push(flag);
    lastX = p.x;
    lastY = p.y;
  }
  for (const f of flags) w.u8(f);
  w.raw(xBytes.bytes);
  w.raw(yBytes.bytes);
  while (w.bytes.length % 4 !== 0) w.u8(0);
  return { data: w.buffer(), bbox, points: points.length, contours: contours.length };
}

// Tables -------------------------------------------------------------------------------------------

function cmapTable(map) {
  const cps = [...map.keys()].filter((cp) => cp <= 0xffff).sort((a, b) => a - b);
  const segments = [];
  for (const cp of cps) {
    const gid = map.get(cp);
    const last = segments.at(-1);
    if (last && cp === last.end + 1 && gid === last.gid + (cp - last.start)) last.end = cp;
    else segments.push({ start: cp, end: cp, gid });
  }
  segments.push({ start: 0xffff, end: 0xffff, gid: 0 });
  const n = segments.length;
  const sub = new Writer();
  sub.u16(4);
  sub.u16(16 + n * 8);
  sub.u16(0);
  sub.u16(n * 2);
  for (const v of searchParams(n, 2)) sub.u16(v);
  for (const s of segments) sub.u16(s.end);
  sub.u16(0);
  for (const s of segments) sub.u16(s.start);
  for (const s of segments) sub.u16(s.start === 0xffff ? 1 : (s.gid - s.start + 0x10000) & 0xffff);
  for (let i = 0; i < n; i++) sub.u16(0);
  const w = new Writer();
  w.u16(0);
  w.u16(2);
  for (const [platform, encoding] of [
    [0, 3],
    [3, 1],
  ]) {
    w.u16(platform);
    w.u16(encoding);
    w.u32(4 + 2 * 8);
  }
  w.raw(sub.bytes);
  return w.buffer();
}

function nameTable(records) {
  const entries = Object.entries(records)
    .map(([id, text]) => ({ id: Number(id), data: Buffer.from(text, "utf16le").swap16() }))
    .sort((a, b) => a.id - b.id);
  const w = new Writer();
  w.u16(0);
  w.u16(entries.length);
  w.u16(6 + entries.length * 12);
  let offset = 0;
  for (const e of entries) {
    w.u16(3);
    w.u16(1);
    w.u16(0x409);
    w.u16(e.id);
    w.u16(e.data.length);
    w.u16(offset);
    offset += e.data.length;
  }
  for (const e of entries) w.raw(e.data);
  return w.buffer();
}

function kernTable(pairs) {
  const w = new Writer();
  w.u16(0);
  w.u16(1);
  w.u16(0);
  w.u16(14 + pairs.length * 6);
  w.u16(0x0001);
  w.u16(pairs.length);
  for (const v of searchParams(pairs.length, 6)) w.u16(v);
  for (const [left, right, value] of pairs) {
    w.u16(left);
    w.u16(right);
    w.i16(value);
  }
  return w.buffer();
}

// WOFF2 to TTF -------------------------------------------------------------------------------------

function encodeComposite(components, bbox) {
  const w = new Writer();
  w.i16(-1);
  w.i16(bbox.minX);
  w.i16(bbox.minY);
  w.i16(bbox.maxX);
  w.i16(bbox.maxY);
  const f2dot14 = (v) => w.i16(Math.round(v * 16384));
  components.forEach((c, i) => {
    const twoByTwo = c.scale01 !== 0 || c.scale10 !== 0;
    const xy = !twoByTwo && c.scaleX !== c.scaleY;
    const one = !twoByTwo && !xy && c.scaleX !== 1;
    // ARG_1_AND_2_ARE_WORDS | ARGS_ARE_XY_VALUES, then the scale form and MORE_COMPONENTS.
    w.u16(0x0003 | (one ? 0x0008 : 0) | (i < components.length - 1 ? 0x0020 : 0) | (xy ? 0x0040 : 0) | (twoByTwo ? 0x0080 : 0));
    w.u16(c.glyphID);
    w.i16(c.dx);
    w.i16(c.dy);
    if (one) f2dot14(c.scaleX);
    if (xy) {
      f2dot14(c.scaleX);
      f2dot14(c.scaleY);
    }
    if (twoByTwo) {
      f2dot14(c.scaleX);
      f2dot14(c.scale01);
      f2dot14(c.scale10);
      f2dot14(c.scaleY);
    }
  });
  while (w.bytes.length % 4 !== 0) w.u8(0);
  return w.buffer();
}

/**
 * A WOFF2 file as a plain TTF: fontkit decodes WOFF2's transformed glyf table up front and so never
 * applies gvar to it, while a TTF instances properly. The glyphs keep every point in order (gvar
 * numbers them); hinting instructions are dropped; every other table is copied as is.
 */
function woff2ToTtf(buffer) {
  const font = fontkit.create(buffer);
  font.getGlyph(0);
  const glyphs = font._transformedGlyphs.map((g, id) => {
    if (!g || g.numberOfContours === 0) return Buffer.alloc(0);
    if (g.numberOfContours < 0) {
      const box = font.getGlyph(id).path.bbox;
      return encodeComposite(g.components, { minX: Math.floor(box.minX), minY: Math.floor(box.minY), maxX: Math.ceil(box.maxX), maxY: Math.ceil(box.maxY) });
    }
    const contours = [];
    let current = [];
    for (const p of g.points) {
      current.push({ x: p.x, y: p.y, on: p.onCurve });
      if (p.endContour) {
        contours.push(current);
        current = [];
      }
    }
    return encodeGlyph(contours).data;
  });
  const loca = new Writer();
  let offset = 0;
  for (const g of glyphs) {
    loca.u32(offset);
    offset += g.length;
  }
  loca.u32(offset);
  const tables = {};
  for (const [tag, entry] of Object.entries(font.directory.tables)) {
    if (tag === "glyf" || tag === "loca" || tag === "DSIG") continue;
    tables[tag] = Buffer.from(font._getTableStream(tag).readBuffer(entry.length));
  }
  tables.glyf = Buffer.concat(glyphs);
  tables.loca = loca.buffer();
  tables.head = Buffer.from(tables.head);
  tables.head.writeInt16BE(1, 50); // indexToLocFormat: long offsets
  return assemble(tables).sfnt;
}

/** ≤ or ≥: the chevron raised by half a bar and a gap, the lower bar of = under it, centred as the chevron was. */
function synthesize(font, chevronCodePoint) {
  const chevron = font.glyphForCodePoint(chevronCodePoint);
  const outline = contoursOf(chevron);
  const bars = contoursOf(font.glyphForCodePoint(0x3d))
    .map((c) => ({ yMin: Math.min(...c.map((p) => p.y)), yMax: Math.max(...c.map((p) => p.y)) }))
    .sort((a, b) => a.yMin - b.yMin);
  const [low, high] = bars;
  if (!low || !high) throw new Error("= has no two bars to draw ≤ and ≥ from");
  const thick = low.yMax - low.yMin;
  const shift = Math.round((thick + (high.yMin - low.yMax)) / 2);
  const points = outline.flat();
  const x0 = Math.min(...points.map((p) => p.x));
  const x1 = Math.max(...points.map((p) => p.x));
  const y0 = Math.min(...points.map((p) => p.y)) - shift;
  const raised = outline.map((c) => c.map((p) => ({ ...p, y: p.y + shift })));
  const bar = [
    { x: x0, y: y0, on: true },
    { x: x0, y: y0 + thick, on: true },
    { x: x1, y: y0 + thick, on: true },
    { x: x1, y: y0, on: true },
  ];
  return { contours: [...raised, bar], advance: Math.round(chevron.advanceWidth) };
}

// One face -----------------------------------------------------------------------------------------

function buildFace(face, cps) {
  const sources = face.files.map((file) => fontkit.create(woff2ToTtf(readFileSync(path.join(face.pkg, "files", file)))).getVariation({ wght: face.weight }));
  const [main] = sources;
  const glyphs = [{ glyph: main.getGlyph(0) }];
  const cmap = new Map();
  const byKey = new Map();
  const missing = [];
  for (const cp of cps) {
    const index = sources.findIndex((f) => f.hasGlyphForCodePoint(cp));
    if (index < 0) {
      if (SYNTHETIC.has(cp)) {
        cmap.set(cp, glyphs.length);
        glyphs.push(synthesize(main, SYNTHETIC.get(cp)));
      } else missing.push(cp);
      continue;
    }
    const glyph = sources[index].glyphForCodePoint(cp);
    const key = `${index}:${glyph.id}`;
    let gid = byKey.get(key);
    if (gid === undefined) {
      gid = glyphs.length;
      glyphs.push({ glyph });
      byKey.set(key, gid);
    }
    cmap.set(cp, gid);
  }
  if (missing.length > 0) throw new Error(`${face.out}: no glyph for ${missing.map((cp) => "U+" + cp.toString(16).toUpperCase().padStart(4, "0")).join(", ")}`);

  const encoded = glyphs.map((g) => (g.glyph ? { ...encodeGlyph(contoursOf(g.glyph)), advance: Math.round(g.glyph.advanceWidth) } : { ...encodeGlyph(g.contours), advance: g.advance }));
  const glyf = Buffer.concat(encoded.map((g) => g.data));
  const loca = new Writer();
  let offset = 0;
  for (const g of encoded) {
    loca.u32(offset);
    offset += g.data.length;
  }
  loca.u32(offset);
  const hmtx = new Writer();
  for (const g of encoded) {
    hmtx.u16(g.advance);
    hmtx.i16(g.bbox ? g.bbox.xMin : 0);
  }

  const boxes = encoded.filter((g) => g.bbox);
  const bbox = {
    xMin: Math.min(...boxes.map((g) => g.bbox.xMin)),
    yMin: Math.min(...boxes.map((g) => g.bbox.yMin)),
    xMax: Math.max(...boxes.map((g) => g.bbox.xMax)),
    yMax: Math.max(...boxes.map((g) => g.bbox.yMax)),
  };

  // Pair kerning as the source's GPOS sets it for each pair alone, ligatures off.
  const kerned = cps.filter((cp) => KERNED(cp) && main.hasGlyphForCodePoint(cp));
  let pairs = [];
  for (const a of kerned) {
    for (const b of kerned) {
      const run = main.layout(String.fromCodePoint(a, b), NO_LIGATURES);
      if (run.glyphs.length !== 2) continue;
      const value = Math.round(run.positions[0].xAdvance - run.glyphs[0].advanceWidth);
      if (value !== 0) pairs.push([cmap.get(a), cmap.get(b), value]);
    }
  }
  if (pairs.length > MAX_PAIRS) pairs = [...pairs].sort((p, q) => Math.abs(q[2]) - Math.abs(p[2])).slice(0, MAX_PAIRS);
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);

  const os2 = main["OS/2"];
  const hhea = main.hhea;
  const head = main.head;
  const advances = encoded.map((g) => g.advance).filter((a) => a > 0);
  const name = main.name.records;
  const version = name.version?.en ?? "";
  const style = `${face.weight}`;
  const sourceName = name.fontFamily?.en ?? "";

  const headW = new Writer();
  headW.u32(0x00010000);
  headW.u32(head.revision);
  headW.u32(0); // checkSumAdjustment, set once the font is assembled
  headW.u32(0x5f0f3cf5);
  headW.u16(0x0003);
  headW.u16(main.unitsPerEm);
  for (let i = 0; i < 4; i++) headW.u32(0); // created and modified: 0 keeps the build reproducible
  headW.i16(bbox.xMin);
  headW.i16(bbox.yMin);
  headW.i16(bbox.xMax);
  headW.i16(bbox.yMax);
  headW.u16(0);
  headW.u16(head.lowestRecPPEM);
  headW.i16(2);
  headW.i16(1);
  headW.i16(0);

  const hheaW = new Writer();
  hheaW.u32(0x00010000);
  hheaW.i16(hhea.ascent);
  hheaW.i16(hhea.descent);
  hheaW.i16(hhea.lineGap);
  hheaW.u16(Math.max(...encoded.map((g) => g.advance)));
  hheaW.i16(Math.min(...boxes.map((g) => g.bbox.xMin)));
  hheaW.i16(Math.min(...boxes.map((g) => g.advance - g.bbox.xMax)));
  hheaW.i16(Math.max(...boxes.map((g) => g.bbox.xMax)));
  hheaW.i16(1);
  hheaW.i16(0);
  hheaW.i16(0);
  for (let i = 0; i < 4; i++) hheaW.i16(0);
  hheaW.i16(0);
  hheaW.u16(encoded.length);

  const maxp = new Writer();
  maxp.u32(0x00010000);
  maxp.u16(encoded.length);
  maxp.u16(Math.max(...encoded.map((g) => g.points)));
  maxp.u16(Math.max(...encoded.map((g) => g.contours)));
  maxp.u16(0);
  maxp.u16(0);
  maxp.u16(2);
  for (let i = 0; i < 8; i++) maxp.u16(0);

  const os2W = new Writer();
  os2W.u16(4);
  os2W.i16(Math.round(advances.reduce((s, a) => s + a, 0) / advances.length));
  os2W.u16(face.weight);
  os2W.u16(5);
  os2W.u16(0);
  for (const v of [
    os2.ySubscriptXSize,
    os2.ySubscriptYSize,
    os2.ySubscriptXOffset,
    os2.ySubscriptYOffset,
    os2.ySuperscriptXSize,
    os2.ySuperscriptYSize,
    os2.ySuperscriptXOffset,
    os2.ySuperscriptYOffset,
    os2.yStrikeoutSize,
    os2.yStrikeoutPosition,
  ])
    os2W.i16(v);
  os2W.i16(0);
  os2W.raw(os2.panose);
  for (const v of os2.ulCharRange) os2W.u32(v);
  os2W.tag(os2.vendorID);
  os2W.u16((face.weight === 400 ? 0x40 : 0) | (os2.fsSelection.useTypoMetrics ? 0x80 : 0));
  const mapped = [...cmap.keys()];
  os2W.u16(Math.min(...mapped));
  os2W.u16(Math.min(0xffff, Math.max(...mapped)));
  os2W.i16(os2.typoAscender);
  os2W.i16(os2.typoDescender);
  os2W.i16(os2.typoLineGap);
  os2W.u16(os2.winAscent);
  os2W.u16(os2.winDescent);
  for (const v of os2.codePageRange) os2W.u32(v);
  os2W.i16(os2.xHeight);
  os2W.i16(os2.capHeight);
  os2W.u16(0);
  os2W.u16(32);
  os2W.u16(2);

  const post = new Writer();
  post.u32(0x00030000);
  post.u32(0);
  post.i16(main.post.underlinePosition);
  post.i16(main.post.underlineThickness);
  for (let i = 0; i < 5; i++) post.u32(0);

  const psFamily = face.family.replace(/\s+/g, "");
  const tables = {
    "OS/2": os2W.buffer(),
    cmap: cmapTable(cmap),
    glyf,
    head: headW.buffer(),
    hhea: hheaW.buffer(),
    hmtx: hmtx.buffer(),
    kern: kernTable(pairs),
    loca: loca.buffer(),
    maxp: maxp.buffer(),
    name: nameTable({
      0: name.copyright?.en ?? "",
      1: face.family,
      2: "Regular",
      3: `${face.family} ${style}`,
      4: `${face.family} ${style}`,
      5: "Version 1.000",
      6: `${psFamily}-${style}`,
      10: `Static weight ${style} instance of ${sourceName} (${version}), cut to the characters of Culture Terminal share cards. A Modified Version under the SIL Open Font License 1.1.`,
      13: "This Font Software is licensed under the SIL Open Font License, Version 1.1.",
      14: "https://openfontlicense.org",
    }),
    post: post.buffer(),
  };
  return { ...sfntToWoff(tables), glyphs: encoded.length, pairs: pairs.length, cmap };
}

/** The sfnt of these tables, and its head with the checksum adjustment set. */
function assemble(tables) {
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  const sums = Object.fromEntries(tags.map((t) => [t, checksum(tables[t])]));
  const sfnt = new Writer();
  sfnt.u32(0x00010000);
  sfnt.u16(n);
  for (const v of searchParams(n, 16)) sfnt.u16(v);
  let offset = 12 + 16 * n;
  for (const t of tags) {
    sfnt.tag(t);
    sfnt.u32(sums[t]);
    sfnt.u32(offset);
    sfnt.u32(tables[t].length);
    offset += align4(tables[t].length);
  }
  for (const t of tags) {
    sfnt.raw(tables[t]);
    while (sfnt.bytes.length % 4 !== 0) sfnt.u8(0);
  }
  const out = sfnt.buffer();
  const adjustment = (0xb1b0afba - checksum(out) + 0x100000000) % 0x100000000;
  const head = Buffer.from(tables.head);
  head.writeUInt32BE(adjustment, 8);
  const headAt = 12 + 16 * n + tags.slice(0, tags.indexOf("head")).reduce((s, t) => s + align4(tables[t].length), 0);
  head.copy(out, headAt);
  return { sfnt: out, head, sums, tags };
}

/** The tables as WOFF 1.0: each one zlib-compressed when that makes it smaller. */
function sfntToWoff(tables) {
  const { head, sums, tags } = assemble(tables);
  const n = tags.length;
  const blobs = tags.map((t) => {
    const data = t === "head" ? head : tables[t];
    const packed = deflateSync(data, { level: 9 });
    return { tag: t, data: packed.length < data.length ? packed : data, origLength: data.length, sum: sums[t] };
  });
  const woff = new Writer();
  const headerSize = 44 + 20 * n;
  let at = headerSize;
  const placed = blobs.map((b) => {
    const entry = { ...b, offset: at };
    at += align4(b.data.length);
    return entry;
  });
  woff.tag("wOFF");
  woff.u32(0x00010000);
  woff.u32(at);
  woff.u16(n);
  woff.u16(0);
  woff.u32(12 + 16 * n + tags.reduce((s, t) => s + align4(tables[t].length), 0));
  woff.u16(1);
  woff.u16(0);
  for (let i = 0; i < 5; i++) woff.u32(0);
  for (const b of placed) {
    woff.tag(b.tag);
    woff.u32(b.offset);
    woff.u32(b.data.length);
    woff.u32(b.origLength);
    woff.u32(b.sum);
  }
  for (const b of placed) {
    woff.raw(b.data);
    while (woff.bytes.length % 4 !== 0) woff.u8(0);
  }
  return { woff: woff.buffer() };
}

// Main ---------------------------------------------------------------------------------------------

const cps = codePoints();
const metrics = {};
for (const face of FACES) {
  const built = buildFace(face, cps);
  writeFileSync(path.join(here, face.out), built.woff);
  // Read it back: every code point maps to the glyph with the instance's advance.
  const check = fontkit.create(built.woff);
  for (const cp of cps) {
    if (!check.hasGlyphForCodePoint(cp)) throw new Error(`${face.out}: U+${cp.toString(16)} lost in the build`);
  }
  if (face.metrics) metrics[face.metrics] = { unitsPerEm: check.unitsPerEm, advances: cps.map((cp) => check.glyphForCodePoint(cp).advanceWidth) };
  console.log(`${face.out}: ${built.glyphs} glyphs, ${built.pairs} kerning pairs, ${built.woff.length} bytes`);
}
// One line per face: the advances follow charset.json's code points in order.
const faces = Object.entries(metrics).map(([name, m]) => `    ${JSON.stringify(name)}: { "unitsPerEm": ${m.unitsPerEm}, "advances": ${JSON.stringify(m.advances)} }`);
const description =
  "Advance widths of the card's sans faces in font units, one per code point of charset.json in its order (build-fonts.mjs writes them). lib/og/measure.ts fits labels to their slots with them.";
writeFileSync(path.join(here, "metrics.json"), `{\n  "description": ${JSON.stringify(description)},\n  "faces": {\n${faces.join(",\n")}\n  }\n}\n`);
console.log(`metrics.json: ${Object.keys(metrics).join(", ")}`);
for (const copy of COPIES) {
  copyFileSync(copy.from, path.join(here, copy.to));
  console.log(`${copy.to}: copied`);
}
for (const licence of LICENCES) {
  const text = readFileSync(path.join(licence.pkg, "LICENSE"), "utf8");
  const at = text.indexOf(OFL_START);
  if (at < 0) throw new Error(`${licence.pkg}/LICENSE is not the SIL OFL`);
  const notice = fontkit.create(readFileSync(path.join(licence.pkg, "files", licence.font))).copyright;
  if (!notice) throw new Error(`${licence.font} has no copyright notice`);
  writeFileSync(path.join(here, licence.to), `${notice}\n\n${text.slice(at)}`);
  console.log(`${licence.to}: written`);
}
