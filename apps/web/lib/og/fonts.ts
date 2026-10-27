import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ImageResponse } from "next/og";
import { OG_FONT } from "./tokens";

/**
 * The share card's fonts (serif reads, sans operates, mono traces), read from lib/og/fonts once per
 * process. They are Inter and Source Serif 4 as static WOFF instances at the card's weights
 * (fonts/build-fonts.mjs: next/og reads neither WOFF2 nor variable weights) and IBM Plex Mono as
 * published, committed with the card; the pages themselves set Bricolage Grotesque, Geist and Geist
 * Mono. Nothing is fetched at render.
 */

type ImageOptions = NonNullable<ConstructorParameters<typeof ImageResponse>[1]>;
export type OgFont = NonNullable<ImageOptions["fonts"]>[number];

const FACES: readonly { name: string; file: string; weight: OgFont["weight"] }[] = [
  { name: OG_FONT.sans, file: "card-sans-400.woff", weight: 400 },
  { name: OG_FONT.sans, file: "card-sans-600.woff", weight: 600 },
  { name: OG_FONT.serif, file: "card-serif-500.woff", weight: 500 },
  { name: OG_FONT.serif, file: "card-serif-600.woff", weight: 600 },
  { name: OG_FONT.mono, file: "ibm-plex-mono-latin-400-normal.woff", weight: 400 },
];

/**
 * Where the font files are: apps/web/lib/og/fonts. The app runs from apps/web (next dev, next start
 * and the standalone server); tools and tests run from the repository root.
 */
export function ogFontDirs(cwd: string = process.cwd()): string[] {
  return [path.join(cwd, "lib", "og", "fonts"), path.join(cwd, "apps", "web", "lib", "og", "fonts")];
}

async function readFace(file: string, dirs: readonly string[]): Promise<ArrayBuffer> {
  for (const dir of dirs) {
    try {
      const data = await readFile(path.join(dir, file));
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  throw new Error(`share card font ${file} not found in ${dirs.join(", ")}`);
}

let loaded: Promise<OgFont[]> | null = null;

/** The card's fonts for ImageResponse, read once; a failed read is retried on the next card. */
export function ogFonts(dirs: readonly string[] = ogFontDirs()): Promise<OgFont[]> {
  loaded ??= Promise.all(FACES.map(async (f) => ({ name: f.name, data: await readFace(f.file, dirs), weight: f.weight, style: "normal" as const }))).catch(
    (err: unknown) => {
      loaded = null;
      throw err;
    },
  );
  return loaded;
}
