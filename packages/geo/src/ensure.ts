import { MetroId, type GeoApi } from "@ct/contracts";

/**
 * Where a skill runs, its caller loads the polygons of the metros the skill input names first
 * (createGeo loads each metro's polygons on first use). Tool inputs name a gazetteer metro in a
 * `metro` field: geo_lift's, an area's (AreaArg), a city context's. Data-free, so tools import it by
 * path without loading any gazetteer.
 */

/** The gazetteer metros a tool input names: every `metro` field, at any depth, that holds a MetroId. */
export function metrosIn(input: unknown): MetroId[] {
  const found = new Set<MetroId>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const [key, v] of Object.entries(value)) {
      if (key === "metro") {
        const metro = MetroId.safeParse(v);
        if (metro.success) found.add(metro.data);
      }
      visit(v, depth + 1);
    }
  };
  visit(input, 0);
  return [...found];
}

/**
 * Loads the polygons of each metro before locate or polygonWkt is asked for it. A GeoApi without a
 * loader (a test double, the CLI stub) is used as it is.
 */
export async function ensureMetros(geo: GeoApi, metros: Iterable<MetroId>): Promise<void> {
  const ensure = (geo as Partial<{ ensure(metro: MetroId): Promise<void> }>).ensure;
  if (typeof ensure !== "function") return;
  await Promise.all([...metros].map((metro) => ensure.call(geo, metro)));
}

/** ensureMetros for every metro a tool input names. */
export function ensureMetrosIn(geo: GeoApi, input: unknown): Promise<void> {
  return ensureMetros(geo, metrosIn(input));
}
