import metros from "../../../../config/metros.json";

/**
 * The state of a market row ("Chattanooga" + "TN", §2.9 G-R4): config/metros.json lists every market
 * with its two-letter state. A share grid's metro rows are keyed `metro:<market id>` (or the bare id);
 * a row keyed any other way is matched by its label. Names and states only (D29).
 */

interface MarketEntry {
  id: string;
  label: string;
  state: string;
  query: string;
}

const ALL: readonly MarketEntry[] = [...metros.gazetteer, ...metros.markets];

const BY_ID: ReadonlyMap<string, string> = new Map(ALL.map((m) => [m.id, m.state]));

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Only names that point at one state: "Portland" or "Springfield" in two states would guess. */
const BY_NAME: ReadonlyMap<string, string> = (() => {
  const states = new Map<string, Set<string>>();
  for (const m of ALL) {
    for (const name of [m.label, m.query]) {
      const key = words(name);
      states.set(key, (states.get(key) ?? new Set()).add(m.state));
    }
  }
  return new Map([...states].filter(([, s]) => s.size === 1).map(([k, s]) => [k, [...s][0] as string]));
})();

/** The row's two-letter state, or null when the row is not a known market. */
export function marketState(row: { key: string; label: string }): string | null {
  return BY_ID.get(row.key.replace(/^metro:/, "")) ?? BY_NAME.get(words(row.label)) ?? null;
}
