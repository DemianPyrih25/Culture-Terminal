import { METRO_ID_VALUES, METRO_LABEL } from "@ct/contracts/values";

/** The map cities, from the gazetteer: neighbourhood maps exist only for these. */
export const MAP_CITIES: readonly string[] = METRO_ID_VALUES.map((id) => METRO_LABEL[id]).sort((a, b) => a.localeCompare(b));
/** Where neighbourhood maps exist, as a short line under the box (the city list sits in its title). */
export const MAP_COVERAGE = `Neighbourhood maps: ${MAP_CITIES.length} US cities`;
