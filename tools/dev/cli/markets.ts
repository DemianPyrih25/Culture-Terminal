// The markets of config/metros.json for the locality tools: ids, labels, /search queries and states
// (D29: names, query strings and public coordinates only; locality ids are pinned in kv). The file
// is read at run time, so a malformed config fails the command with a plain message.
import { readFileSync } from "node:fs";
import { MarketId, type LatLon } from "@ct/contracts";
import { z } from "zod";

const METROS_JSON = new URL("../../../config/metros.json", import.meta.url);

const Entry = z.object({
  id: MarketId,
  label: z.string().min(1),
  state: z.string().min(1),
  state_name: z.string().min(1),
  query: z.string().min(1),
  pin: z.literal("deliberate").optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
});
type Entry = z.infer<typeof Entry>;

const MetrosConfig = z.object({
  gazetteer: z.array(Entry),
  reserved: z.array(Entry).default([]),
  markets: z.array(Entry).min(1),
});

export interface Market {
  id: MarketId;
  label: string;
  /** Two-letter state code, e.g. TN. */
  state: string;
  /** The state's name, which a locality's disambiguation carries, e.g. Tennessee. */
  stateName: string;
  /** The /search query for the market's locality. */
  query: string;
  /** config `pin: deliberate`: the name is ambiguous, so its locality is chosen by hand, never automatically. */
  deliberate: boolean;
  /** The public centre of a gazetteer or reserved metro, for telling ambiguous localities apart; null otherwise. */
  center: LatLon | null;
}

/** A config/metros.json the locality tools cannot use. */
export class MarketsConfigError extends Error {
  override readonly name = "MarketsConfigError";
}

/** The `markets` list parsed from metros.json text, with the centre of each gazetteer or reserved metro of the same id. */
export function parseMarkets(text: string): Market[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new MarketsConfigError(`config/metros.json is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = MetrosConfig.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new MarketsConfigError(`config/metros.json: ${issue?.path.join(".") || "(file)"}: ${issue?.message ?? "invalid"}`);
  }
  const { gazetteer, reserved, markets } = parsed.data;
  const centres = new Map<string, Entry["center"]>([...gazetteer, ...reserved].map((e) => [e.id, e.center]));
  const seen = new Set<string>();
  return markets.map((e) => {
    if (seen.has(e.id)) throw new MarketsConfigError(`config/metros.json: market "${e.id}" is listed twice`);
    seen.add(e.id);
    const center = e.center ?? centres.get(e.id) ?? null;
    return {
      id: e.id,
      label: e.label,
      state: e.state,
      stateName: e.state_name,
      query: e.query,
      deliberate: e.pin === "deliberate",
      center,
    };
  });
}

export function loadMarkets(file: URL | string = METROS_JSON): Market[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new MarketsConfigError(`cannot read config/metros.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseMarkets(text);
}
