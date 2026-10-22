# Attribution

Culture Terminal is released under the MIT License (see `LICENSE`). It uses the third-party work below, each under its own licence.

## Fonts

All fonts are self-hosted through [Fontsource](https://fontsource.org) packages.

| Font | Licence | Package |
|---|---|---|
| IBM Plex Mono | SIL Open Font License 1.1 | `@fontsource/ibm-plex-mono` |
| IBM Plex Sans | SIL Open Font License 1.1 | `@fontsource/ibm-plex-sans` |
| IBM Plex Sans Condensed | SIL Open Font License 1.1 | `@fontsource/ibm-plex-sans-condensed` |
| Instrument Serif | SIL Open Font License 1.1 | `@fontsource/instrument-serif` |

IBM Plex is a trademark of IBM Corp. The OFL text is at <https://openfontlicense.org>.

## Charts and maps

| Library | Licence | Project |
|---|---|---|
| Apache ECharts | Apache License 2.0 | <https://echarts.apache.org> |
| MapLibre GL JS | BSD 3-Clause License | <https://github.com/maplibre/maplibre-gl-js> |
| deck.gl | MIT License | <https://deck.gl> |

## Basemap

The map uses the OpenFreeMap dark style (`https://tiles.openfreemap.org/styles/dark`). Every map shows this attribution:

> © OpenFreeMap © OpenMapTiles © OpenStreetMap contributors

Map data comes from OpenStreetMap and is available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/). The vector tile schema is OpenMapTiles. Tiles are served by [OpenFreeMap](https://openfreemap.org).

## Neighbourhood gazetteers

The neighbourhood boundaries for each metro come from public datasets. Each source and its licence is listed here when that gazetteer is built.

## Qloo

Taste data comes from the [Qloo](https://qloo.com) API at runtime. **No Qloo data is stored in this repository**: no responses, scores, entity IDs or request IDs. Responses are cached privately in the application's database, and `pnpm guard` and gitleaks check every commit for leaks.
