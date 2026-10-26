// Builds a ZIP-area gazetteer for a further metro (D28's ZCTA fallback, P1 #12): the Census Bureau's 2020
// ZIP Code Tabulation Areas clipped to the metro's counties, labelled as ZIP areas, the way Nashville's
// was built (D37). Areas are zcta_<zip>, named "ZIP 37206", and answer to "ZIP 37206" and "37206".
//
// Usage: pnpm exec tsx tools/geo/zcta.ts --metro <id> --label <clip outline> --counties <file> --county <GEOID> [--county ...]
//          [--zctas <file>] [--part-label <text>] [--aliases <file.json>] [--interval <m>] [--out <file>] [--dry]
//
// Adding a metro:
// 1. County outlines. Either the TIGERweb Census 2020 counties layer, by GEOID (state and county FIPS):
//      https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/82/query?where=GEOID+IN+('47037')&outFields=GEOID,BASENAME&outSR=4326&f=geojson
//    or the national TIGER/Line counties file, https://www2.census.gov/geo/tiger/TIGER2020/COUNTY/tl_2020_us_county.zip.
// 2. ZCTAs. Run the build without --zctas: it prints the TIGERweb ZCTA layer query (layer 84) for the box
//    around the counties. Or pass the national TIGER/Line file,
//    https://www2.census.gov/geo/tiger/TIGER2020/ZCTA520/tl_2020_us_zcta520.zip (about 500 MB, read as it
//    is: only the ZCTAs meeting the counties' box are kept; give Node more memory if it runs short).
//    Download both to a local folder outside the repository; they are never committed.
// 3. Run the build. --label names the clip outline in captions ("Davidson County"). A ZIP area that keeps
//    less than 90% of its area inside is labelled "(<part label> part)", by default the label without
//    "County" ("Davidson part"), so a suburban ZIP's sliver is not read as the whole town. --aliases is an
//    optional JSON object of approximate neighbourhood names per ZIP ({"37206": ["East Nashville"]});
//    keep a name only where the place's USGS GNIS point lies well inside the ZIP area, and test each one.
//    Nashville's: --metro nashville --label "Davidson County" --county 47037 --aliases
//    tools/geo/nashville-aliases.json reproduces packages/geo/src/data/nashville.ts with the same ids,
//    names, aliases, centroids and areas. 25 of its rings start at another vertex, which changes their
//    query WKT and so the Qloo cache keys of those areas, so the shipped module is kept as it is.
// 4. Wire it in. In packages/geo: import the module into GAZETTEERS (src/gazetteer.ts), give the metro rows
//    in test/gazetteers.test.ts (box, largest area, centroids outside, size budget, landmarks) and a
//    section in ATTRIBUTION.md. The rest is outside this package, and the build or the tests fail
//    until each is done:
//    - packages/contracts/src/enums.ts: the id joins MetroId and METRO_LABEL; createGeo serves the
//      gazetteer from then on. packages/contracts/test/tools.test.ts must not use it as an unsupported metro.
//    - config/metros.json: a gazetteer entry (status "built", source as the module's) and a market with
//      the same id, label, state and query.
//    - packages/quant/src/skills/metros.ts: its centre in METRO_CENTRES, a Record over MetroId.
//    - packages/agent/prompts/clerk.md (the metro field names every MetroId) and director.md (the
//      gazetteer metros), then `pnpm prompts:build`.
//    - Copy that names the metros: packages/agent/src/run/gate.ts and scan.ts (and test/run/scan.test.ts),
//      apps/web/components/ask/fixtures.ts, and the ask tests that spell out the city list
//      (apps/web/test/ask/ask-machine.test.ts, ask-panel.test.tsx).
//    - Locality pins: every MetroId is a required market (apps/web/server/localities.ts), so pin it in kv,
//      live and mock (tools/dev/localities.ts pin <id>, and again with --mock), and add it to the
//      required markets in apps/web/test/localities.test.ts, startup.test.ts and
//      status/status.integration.test.tsx.
//    - The sample runs: pnpm exec tsx tools/dev/sample-run.ts.
//    - Optional: GAZETTEER_METROS in tools/llm-bench/scenario.ts, and a mock metro in
//      packages/qloo/src/mock/metros.ts for mock runs there.
//
// Cells outside every ZIP area (water, a county the build leaves out, a skipped sliver) locate to no area
// and stay out of the lift rollup, as in every gazetteer. The files are data: parsed, never run.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { areaKm2 } from "../../packages/geo/src/measure";
import { bboxOfShapes, buildAreas, describeAreas, km2, moduleText, prepare, readFeatures, type Bbox, type BuiltArea, type ModuleSpec, type Parts, type Shape } from "./build";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** A ZCTA cut by the clip outline whose part inside is smaller than this is a sliver, not a district. */
export const MIN_CLIP_KM2 = 1;
/** A ZCTA that keeps less than this share of its area inside is labelled as a part. */
export const MIN_WHOLE_SHARE = 0.9;
/** Nashville's step (D37). */
const INTERVAL_M = 15;
/** ZCTA code fields: TIGER/Line 2020 and later, TIGER/Line 2010, TIGERweb. */
const ZCTA_FIELDS = ["ZCTA5CE20", "ZCTA5CE10", "ZCTA5", "GEOID20", "GEOID10", "GEOID"];
/** County GEOID fields, or their state and county FIPS parts. */
const COUNTY_FIELDS = ["GEOID", "GEOID20", "GEOID10"];

export interface Feature {
  properties: Record<string, unknown> | null;
  geometry: Shape | null;
}

export interface ZctaInput {
  /** The clip outline as captions name it, e.g. "Davidson County". */
  label: string;
  /** The bracket label of a ZIP area mostly outside; defaults to the label without "County". */
  partLabel?: string;
  counties: readonly Feature[];
  /** The counties to clip to, by GEOID (state and county FIPS, e.g. 47037). */
  countyGeoids: readonly string[];
  zctas: readonly Feature[];
  /** Approximate neighbourhood names per ZIP. */
  aliases?: Readonly<Record<string, readonly string[]>>;
  interval?: number;
}

const isShape = (g: Shape | null): g is Shape => g !== null && (g.type === "Polygon" || g.type === "MultiPolygon");
const partsOf = (g: Shape): Parts => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);

function field(properties: Record<string, unknown> | null, names: readonly string[]): string | null {
  for (const name of names) {
    const v = properties?.[name];
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return null;
}

/** A county feature's GEOID: a GEOID field, else its state and county FIPS. */
export function countyGeoid(properties: Record<string, unknown> | null): string | null {
  const geoid = field(properties, COUNTY_FIELDS);
  if (geoid !== null) return geoid;
  const state = field(properties, ["STATEFP", "STATEFP20", "STATE"]);
  const county = field(properties, ["COUNTYFP", "COUNTYFP20", "COUNTY"]);
  return state === null || county === null ? null : `${state}${county}`;
}

/** The selected counties' outlines; every GEOID asked for must be there. */
export function selectCounties(counties: readonly Feature[], geoids: readonly string[]): Shape[] {
  const out: Shape[] = [];
  for (const geoid of geoids) {
    const found = counties.filter((c) => countyGeoid(c.properties) === geoid).map((c) => c.geometry);
    if (found.length === 0 || !found.every(isShape)) throw new Error(`zcta: no county outline with GEOID ${geoid}`);
    out.push(...found);
  }
  return out;
}

/** "Davidson County" → "Davidson": the default part label. */
export const partLabelOf = (label: string): string => label.replace(/\s+(County|Parish|Borough)$/i, "").trim();

/**
 * The ZIP areas of the metro: every ZCTA clipped to the counties. One wholly outside is left out; one
 * whose part inside is a sliver under MIN_CLIP_KM2 is left out too; one keeping less than
 * MIN_WHOLE_SHARE of its area is labelled "(<part label> part)", unless it has an approximate name,
 * which labels it instead. Then the shared build: merges, slivers, simplification, query rings.
 */
export async function buildZcta(input: ZctaInput, report: string[]): Promise<BuiltArea[]> {
  const clip = selectCounties(input.counties, input.countyGeoids);
  const partLabel = input.partLabel ?? partLabelOf(input.label);
  const byZip = new Map<string, Parts>();
  for (const f of input.zctas) {
    const zip = field(f.properties, ZCTA_FIELDS);
    if (zip === null || !/^\d{5}$/.test(zip)) throw new Error("zcta: a feature without a five-digit ZCTA code");
    if (!isShape(f.geometry)) throw new Error(`zcta: ${zip} has no polygon`);
    byZip.set(zip, [...(byZip.get(zip) ?? []), ...partsOf(f.geometry)]);
  }
  const whole = new Map<string, Shape>([...byZip].map(([zip, coordinates]) => [zip, { type: "MultiPolygon", coordinates }]));
  const sources = [...whole].map(([zip, geometry]) => ({ key: zip, id: `zcta_${zip}`, name: `ZIP ${zip}`, aliases: [`ZIP ${zip}`, zip], approximateAliases: [], geometry }));
  const unused = new Set(Object.keys(input.aliases ?? {}));
  const work = (await prepare(sources, report, clip)).filter((w) => {
    const inside = km2(w.parts);
    const share = inside / areaKm2(whole.get(w.key) as Shape);
    if (share < 0.99 && inside < MIN_CLIP_KM2) {
      report.push(`zcta: skipped ${w.key}, ${inside.toFixed(2)} km2 inside ${input.label}`);
      return false;
    }
    if (share < 0.999) report.push(`zcta: ${w.key} clipped to ${input.label}, ${(share * 100).toFixed(0)}% kept`);
    unused.delete(w.key);
    w.approximateAliases = [...(input.aliases?.[w.key] ?? [])];
    const label = w.approximateAliases[0] ?? (share < MIN_WHOLE_SHARE ? `${partLabel} part` : null);
    if (label !== null) w.name = `ZIP ${w.key} (${label})`;
    return true;
  });
  if (unused.size > 0) throw new Error(`zcta: the alias table names ZIPs the build does not keep: ${[...unused].join(", ")}`);
  return buildAreas(work, input.interval ?? INTERVAL_M, report);
}

/** The data module's caption source, constant and header for a ZIP-area metro. */
export function zctaSpec(metro: string, label: string, approximate: boolean): ModuleSpec {
  const names = approximate ? "; neighbourhood names approximate" : "";
  return {
    metro,
    constName: metro.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
    source: `U.S. Census Bureau 2020 ZIP Code Tabulation Areas clipped to ${label}, public domain${names}`,
    header: [
      `// ZIP areas for ${metro} (D28's ZCTA fallback): the Census Bureau's 2020 ZIP Code Tabulation Areas`,
      `// clipped to ${label}, public domain${approximate ? ", with approximate neighbourhood aliases" : ""}. Generated by tools/geo/zcta.ts;`,
      "// ATTRIBUTION.md records the source, licence, retrieval date and every transformation. Do not edit by",
      "// hand: rebuild instead.",
    ],
  };
}

/** The TIGERweb Census 2020 ZCTA query for the ZCTAs meeting a box, as GeoJSON in WGS 84. */
export function tigerwebZctaQuery(box: Bbox): string {
  const envelope = [box.minLon, box.minLat, box.maxLon, box.maxLat].map((x) => x.toFixed(4)).join(",");
  return (
    "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/84/query" +
    `?geometry=${envelope}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=ZCTA5,GEOID&outSR=4326&f=geojson`
  );
}

function readAliases(file: string): Record<string, string[]> {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("zcta: --aliases is not a JSON object");
  const out: Record<string, string[]> = {};
  for (const [zip, names] of Object.entries(raw)) {
    if (!/^\d{5}$/.test(zip) || !Array.isArray(names) || !names.every((n) => typeof n === "string" && n.trim() !== "")) {
      throw new Error(`zcta: --aliases entry ${zip} is not a ZIP with a list of names`);
    }
    out[zip] = names as string[];
  }
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      metro: { type: "string" },
      label: { type: "string" },
      "part-label": { type: "string" },
      counties: { type: "string" },
      county: { type: "string", multiple: true },
      zctas: { type: "string" },
      aliases: { type: "string" },
      interval: { type: "string" },
      out: { type: "string" },
      dry: { type: "boolean" },
    },
  });
  const { metro, label, counties } = values;
  const geoids = values.county ?? [];
  if (metro === undefined || label === undefined || counties === undefined || geoids.length === 0) {
    throw new Error("usage: zcta.ts --metro <id> --label <clip outline> --counties <file> --county <GEOID> [--county ...] [--zctas <file>] [--part-label <text>] [--aliases <file.json>] [--interval m] [--out file] [--dry]");
  }
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(metro)) throw new Error(`zcta: ${metro} is not a metro id such as nashville`);
  const countyFeatures = await readFeatures(counties);
  const box = bboxOfShapes(selectCounties(countyFeatures, geoids));
  if (values.zctas === undefined) {
    console.log(`Download the ZCTAs meeting the counties' box, then pass the file as --zctas:\n${tigerwebZctaQuery(box)}`);
    return;
  }
  const aliases = values.aliases === undefined ? undefined : readAliases(values.aliases);
  const report: string[] = [];
  const zctas = await readFeatures(values.zctas, box);
  report.push(`${zctas.length} ZCTA features meet the box around ${label}`);
  const built = await buildZcta(
    { label, partLabel: values["part-label"], counties: countyFeatures, countyGeoids: geoids, zctas, aliases, interval: values.interval === undefined ? undefined : Number(values.interval) },
    report,
  );
  const text = moduleText(zctaSpec(metro, label, aliases !== undefined), built);
  report.push(`areas ${built.length}, ${built.reduce((s, b) => s + b.areaKm2, 0).toFixed(1)} km2, module ${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`);
  report.push(...describeAreas(built));
  console.log(report.join("\n"));
  if (values.dry !== true) {
    const outFile = values.out ?? path.join(ROOT, `packages/geo/src/data/${metro}.ts`);
    writeFileSync(outFile, text, "utf8");
    console.log(`wrote ${outFile}`);
  }
}

if (path.basename(process.argv[1] ?? "") === "zcta.ts") {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });
}
