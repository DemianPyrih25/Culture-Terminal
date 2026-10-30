// The invented screen the screener spec answers the page with (e2e/screener.spec.ts): three invented
// brands, five invented requests, no Qloo value (D29). It is a ScreenerAnswer of packages/contracts/src/
// screener.ts: an ok cell cites requests of this screen, and an unavailable cell has a reason and no number.

/** The columns' labels (SCREENER_COLUMN_LABEL, written out: the specs import no workspace package). */
export const COLUMN_LABELS = ["FIT", "Distinctiveness", "Next-gen tilt", "Metro breadth", "Popularity", "UNDER-THE-RADAR"] as const;

export type Cell = { status: "ok" | "unavailable"; value: number | null; reason: string | null; display: string | null; requestIds: string[] };

const ok = (value: number, requestIds: string[], display = value.toFixed(2)): Cell => ({ status: "ok", value, reason: null, display, requestIds });
const notMeasured = (requestIds: string[] = []): Cell => ({ status: "unavailable", value: null, reason: "not_measured", display: null, requestIds });

function row(rank: number, label: string, fit: number, tilt: number, popularity: number, flags: string[] = []) {
  return {
    key: `smoke-${rank}`,
    rank,
    label,
    disambiguation: null,
    flags,
    cells: {
      fit: ok(fit, ["Q2"]),
      distinctiveness: notMeasured(),
      next_gen_tilt: ok(tilt, ["Q3", "Q4", "Q5"]),
      metro_breadth: notMeasured(),
      popularity: ok(popularity, ["Q1"]),
      under_the_radar: ok(Math.round((fit - popularity) * 100) / 100, ["Q1", "Q2"]),
    },
  };
}

const request = (id: string, purpose: string, context: string | null, query: Record<string, string>) => ({
  id,
  purpose,
  context,
  request: { source: "qloo", method: "GET", path: "/v2/insights", query },
  requestId: `smoke-${id.toLowerCase()}-req`,
  cache: "miss",
  fetchedAt: "2026-10-29T12:00:00.000Z",
  rows: 20,
  error: null,
});

/** An invented screen of three invented brands (no Qloo value, D29). */
export const SCREEN_ANSWER = {
  kind: "ok",
  screen: {
    seed: { by: "tag", label: "Craft soda" },
    markets: [],
    columns: [
      { key: "fit", label: "FIT", formulaId: "pct.within_call", unit: "pct", badge: "DERIVED" },
      { key: "distinctiveness", label: "Distinctiveness", formulaId: "subs.distinctiveness", unit: "similarity", badge: "DERIVED" },
      { key: "next_gen_tilt", label: "Next-gen tilt", formulaId: "share.youth_tilt", unit: "delta", badge: "DERIVED" },
      { key: "metro_breadth", label: "Metro breadth", formulaId: "share.metros_won", unit: "count", badge: "DERIVED" },
      { key: "popularity", label: "Popularity", formulaId: "popularity", unit: "popularity", badge: "MEASURED" },
      { key: "under_the_radar", label: "UNDER-THE-RADAR", formulaId: "screen.under_the_radar", unit: "score", badge: "DERIVED" },
    ],
    rows: [row(1, "Kestrel Tonic", 0.94, 0.21, 0.42, ["UTR"]), row(2, "Brightwater Soda", 0.81, -0.08, 0.77), row(3, "Juniper Cola", 0.66, 0.05, 0.58)],
    requests: [
      request("Q1", "discovery", null, { "filter.type": "urn:entity:brand", "signal.interests.tags": "urn:tag:smoke:craft_soda", take: "25" }),
      request("Q2", "scoring", null, { "filter.type": "urn:entity:brand", "signal.interests.tags": "urn:tag:smoke:craft_soda", "filter.results.entities": "smoke" }),
      request("Q3", "age", "age 24 and younger", { "filter.type": "urn:entity:brand", "signal.demographics.age": "24_and_younger" }),
      request("Q4", "age", "age 25–29", { "filter.type": "urn:entity:brand", "signal.demographics.age": "25_to_29" }),
      request("Q5", "age", "age 55 and older", { "filter.type": "urn:entity:brand", "signal.demographics.age": "55_and_older" }),
    ],
    map: null,
    limitations: ["Taste fit within this set, not sales or share.", "Metro breadth was not measured: no markets were chosen."],
    mode: "live",
    qloo: { network: 5, cached: 0 },
    createdAt: "2026-10-29T12:00:00.000Z",
  },
} as const;

