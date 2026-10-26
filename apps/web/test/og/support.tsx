// Shared helpers for the share card tests: the synthetic finished runs (invented entities, D29), the
// card's printed text, the ids a run carries, and readers for the card fonts' character maps and widths.
import { readFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { renderToStaticMarkup } from "react-dom/server";
import { reduceRunEvents, type Job, type RunEvent, type RunState } from "@ct/contracts";
import { JOB_RUNS } from "../../app/dev/brief/job-runs";
import { buildBriefModel } from "../../lib/brief";
import { buildOgCard, OgCardImage, type OgCard, type OgCardInput } from "../../lib/og";

export const FONT_DIR = path.join(import.meta.dirname, "..", "..", "lib", "og", "fonts");

/** A job's synthetic finished run, under its own run id, as the permalink reads it. */
export function jobState(job: Job): RunState {
  const events = JOB_RUNS[job]();
  return reduceRunEvents(events[0]!.runId, events);
}

export function stateOf(events: readonly RunEvent[]): RunState {
  return reduceRunEvents(events[0]!.runId, events);
}

/** The card the route draws for a stored run (the model as the permalink builds it). */
export function cardOf(state: RunState, over: Omit<Partial<OgCardInput>, "state"> = {}): OgCard {
  return buildOgCard({ model: buildBriefModel(state, Date.now()), state, ...over });
}

const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

/** Every text node the card draws, in order, one per line. */
export function imageText(card: OgCard): string {
  const html = renderToStaticMarkup(<OgCardImage card={card} />);
  return html
    .replace(/<[^>]*>/g, "\n")
    .replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e] ?? e)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Every opaque id a run carries: run, request, Qloo call, tool call and entity ids (a value under an
 * *id key, 6+ characters with a digit). Public gazetteer ids such as "downtown" are words, not ids.
 */
export function idsIn(state: RunState): string[] {
  const out = new Set<string>();
  const walk = (value: unknown, key: string) => {
    if (typeof value === "string") {
      if (/id$|ids$/i.test(key) && value.length >= 6 && /\d/.test(value)) out.add(value);
    } else if (Array.isArray(value)) {
      for (const v of value) walk(v, key);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  walk(state, "");
  out.add(state.runId);
  return [...out];
}

/** An id shaped like a UUID, built at run time so no UUID is written in the repository (D29). */
export const FAKE_UUID = ["0a0b0c0d", "1e1f", "4a2b", "8c3d", "0e0f0a0b0c0d"].join("-");

// The card fonts' character maps and widths -------------------------------------------------------------

function woffTables(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (let i = 0; i < buf.readUInt16BE(12); i++) {
    const at = 44 + i * 20;
    const tag = buf.toString("latin1", at, at + 4);
    const offset = buf.readUInt32BE(at + 4);
    const compLength = buf.readUInt32BE(at + 8);
    const origLength = buf.readUInt32BE(at + 12);
    const data = buf.subarray(offset, offset + compLength);
    out.set(tag, compLength < origLength ? inflateSync(data) : Buffer.from(data));
  }
  return out;
}

function fontTables(file: string): Map<string, Buffer> {
  const buf = readFileSync(path.join(FONT_DIR, file));
  if (buf.toString("latin1", 0, 4) !== "wOFF") throw new Error(`${file} is not WOFF`);
  return woffTables(buf);
}

/** A WOFF font's glyph id for each code point it maps, from its Windows Unicode (format 4) cmap. */
export function fontGlyphs(file: string): Map<number, number> {
  const cmap = fontTables(file).get("cmap");
  if (!cmap) throw new Error(`${file} has no cmap`);
  const out = new Map<number, number>();
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const platform = cmap.readUInt16BE(4 + i * 8);
    const encoding = cmap.readUInt16BE(6 + i * 8);
    const sub = cmap.readUInt32BE(8 + i * 8);
    if (platform !== 3 || encoding !== 1 || cmap.readUInt16BE(sub) !== 4) continue;
    const segX2 = cmap.readUInt16BE(sub + 6);
    const ends = sub + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const start = cmap.readUInt16BE(starts + s * 2);
      const end = cmap.readUInt16BE(ends + s * 2);
      const delta = cmap.readUInt16BE(deltas + s * 2);
      const rangeOffset = cmap.readUInt16BE(ranges + s * 2);
      for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
        const raw = rangeOffset === 0 ? cp : cmap.readUInt16BE(ranges + s * 2 + rangeOffset + (cp - start) * 2);
        const gid = raw === 0 ? 0 : (raw + delta) & 0xffff;
        if (gid !== 0) out.set(cp, gid);
      }
    }
  }
  return out;
}

/** The code points a WOFF font maps to a glyph. */
export function fontCodePoints(file: string): Set<number> {
  return new Set(fontGlyphs(file).keys());
}

/** A WOFF font's units per em and each mapped code point's advance width, from its head, hhea and hmtx. */
export function fontAdvances(file: string): { unitsPerEm: number; advances: Map<number, number> } {
  const tables = fontTables(file);
  const [head, hhea, hmtx] = ["head", "hhea", "hmtx"].map((tag) => tables.get(tag));
  if (!head || !hhea || !hmtx) throw new Error(`${file} has no metrics`);
  const metrics = hhea.readUInt16BE(34);
  const advances = new Map<number, number>();
  for (const [cp, gid] of fontGlyphs(file)) advances.set(cp, hmtx.readUInt16BE(Math.min(gid, metrics - 1) * 4));
  return { unitsPerEm: head.readUInt16BE(18), advances };
}
