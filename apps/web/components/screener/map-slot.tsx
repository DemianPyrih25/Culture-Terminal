import type { ScreenerResult, TasteMapPayload } from "@ct/contracts";
import { TasteMap } from "../figures";
import { mapSourceText } from "./model";

/**
 * The screen's Category Taste Map, under the table (SPEC §5.3 S1 P1 extension): classical MDS over the
 * screen's own triangular similarity calls (k ≤ 14, ≤ 13 calls). Drawn only when the reader asked for
 * the map; a map that could not be drawn is a line in the screen's limits instead.
 */
export function ScreenerMapSlot({ map, screen }: { map: TasteMapPayload; screen: Pick<ScreenerResult, "requests"> }) {
  return (
    <TasteMap
      data={map}
      kind="Category Taste Map"
      title="How the screened brands' audiences relate"
      formulaId="taste_map_mds"
      source={{ text: mapSourceText(screen), requestId: null }}
      id="taste-map"
    />
  );
}
