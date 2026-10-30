# Attribution

Culture Terminal is released under the MIT License (see `LICENSE`). It uses the third-party work below, each under its own licence.

## Fonts

All fonts are self-hosted through [Fontsource](https://fontsource.org) packages.

| Font | Licence | Package |
|---|---|---|
| Bricolage Grotesque | SIL Open Font License 1.1 | `@fontsource-variable/bricolage-grotesque` |
| Geist | SIL Open Font License 1.1 | `@fontsource-variable/geist` |
| Geist Mono | SIL Open Font License 1.1 | `@fontsource-variable/geist-mono` |
| IBM Plex Mono | SIL Open Font License 1.1 | `@fontsource/ibm-plex-mono` |
| Inter | SIL Open Font License 1.1 | `@fontsource-variable/inter` |
| Source Serif 4 | SIL Open Font License 1.1 (Reserved Font Name "Source") | `@fontsource-variable/source-serif-4` |

IBM Plex is a trademark of IBM Corp. The OFL text is at <https://openfontlicense.org>.

The share cards (`apps/web/lib/og/fonts`) carry static instances of Inter and Source Serif 4, cut to the card's characters and renamed "CT Card Sans" and "CT Card Serif", as the OFL asks of a Modified Version, each with its licence under its own copyright notice beside it. `build-fonts.mjs` in that folder rebuilds them from the packages above.

## Icons

The interface icons (`apps/web/components/ui/icons.tsx`) are path data copied from [Lucide](https://lucide.dev), ISC License, Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT); all other copyright (c) for Lucide are held by Lucide Contributors 2022.

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

The neighbourhood boundaries of the 13 map cities come from public datasets. Each source and its licence is listed here.

### Austin

| | |
|---|---|
| Dataset | Boundaries: City of Austin Neighborhoods (Neighborhood Planning Areas) |
| Publisher | City of Austin. Published on the City of Austin Open Data Portal by Austin Technology Services (Enterprise Open Data Program); the source GIS layer credits Communications and Technology Management/9-1-1 Addressing. |
| URL | <https://data.austintexas.gov/d/inrm-c3ee> |
| Licence | Public domain. The portal's [terms of use](https://data.austintexas.gov/stories/s/ranj-cccq) state that data created by City of Austin employees is not subject to copyright and that, unless the metadata says otherwise, its datasets are in the public domain. This dataset's metadata names no other licence: its licence field reads "See Terms of Use". The City asks users to credit the City of Austin and the source department. |
| Retrieved | 2026-10-23 (GeoJSON export) |
| Used in | `packages/geo/src/data/austin.ts` |

Transformations:

1. Sub-district features are dissolved into one geometry per planning area (95 features, 65 areas).
2. Rings are repaired, and polygon parts and holes under 0.02 km² are dropped. No planning areas overlap. Had any overlapped, the build would give the overlap to the smaller area.
3. The outlines are simplified with [mapshaper](https://github.com/mbloch/mapshaper) (`-clean`, then Visvalingam at a 5 m interval with `keep-shapes`). This keeps the topology, so neighbouring areas share the same border vertices. Coordinates are rounded to 5 decimals and rings are oriented as RFC 7946 requires.
4. Each area gets a query outline for Qloo's `signal.location`: the outer ring of its largest part, reduced to at most 40 points (closing point included) without self-intersections.
5. The centroid of the largest part's outer ring (the display outline, before the reduction in step 4) and the geodesic area in km² are precomputed.
6. Display names are the official names in title case, except that "RMMA" is shown as "Mueller", "UT" as "University of Texas", and the title-cased "Mckinney" is spelled "McKinney". Aliases cover names readers use for a planning area, such as Travis Heights, East Riverside, East 11th, Tarrytown, Clarksville, West Campus and North Campus. An alias that names one of the City's official sub-districts must cover at least half of its planning area, and the build rejects one that does not. Travis Heights-Swisher (84% of South River City) and Cherrywood (63% of Upper Boggy Creek) qualify. Blackland (12%) and Fairview Park (16%) do not, so they are not aliases.

The City publishes these boundaries for information only. They are not for legal, engineering or surveying use.

### Nashville

No Nashville neighbourhood boundary set is published under a licence that allows redistribution. Nashville therefore uses ZIP areas: the Census Bureau's ZIP Code Tabulation Areas, clipped to Davidson County. They are labelled as ZIP areas, and the neighbourhood names they answer to are approximate.

| | |
|---|---|
| Dataset | 2020 Census ZIP Code Tabulation Areas (ZCTAs), and the 2020 Census outline of Davidson County, Tennessee (GEOID 47037), January 1, 2020 vintage |
| Publisher | U.S. Census Bureau, through its TIGERweb map service. The layers credit "U.S. Census Bureau ZIP Code Tabulation Areas (ZCTAs); Census 2020 - January 1, 2020 vintage" and "U.S. Census Bureau Counties (or statistically equivalent entities); 2020 Census - January 1, 2020 vintage". |
| URL | <https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer>, layer 84 (Zip Code Tabulation Areas) and layer 82 (Counties) |
| Licence | Public domain. Census Bureau geography is a work of the U.S. Government, which is not subject to copyright in the United States (17 U.S.C. § 105). |
| Retrieved | 2026-10-23 (GeoJSON from the two layers' query endpoints) |
| Used in | `packages/geo/src/data/nashville.ts` |

ZCTAs are the Census Bureau's generalized areal representations of USPS ZIP Code service areas. They are not the same as ZIP Codes, so the ZIP Code of a street address can differ from the ZCTA the address lies in.

Transformations:

1. The 48 ZCTAs that meet a box around the county are clipped to the Davidson County outline. Eleven lie wholly outside the county and are left out. Fourteen cross the county line and keep only their part inside it. The result is 37 ZIP areas.
2. Rings are repaired, and polygon parts and holes under 0.02 km² are dropped. ZCTAs do not overlap, so no overlap had to be resolved. A ZIP area under 0.1 km² is merged into the neighbour it shares the longest border with, so the map has no hole where it was. This merges ZCTA 37238, a downtown block of about 0.012 km², into 37201, which also answers to "ZIP 37238" and "37238". Enclaves stay as holes that their own ZIP area fills: 37232 inside 37212, and a part of 37214 inside 37217. The 36 ZIP areas cover about 1,361 km², the whole county.
3. The outlines are simplified with [mapshaper](https://github.com/mbloch/mapshaper) (`-clean`, then Visvalingam at a 15 m interval with `keep-shapes`). ZIP areas are larger than Austin's planning areas, so a coarser step keeps the module to about 213 KB (about 8,560 display vertices). Neighbouring areas keep the same border vertices. Coordinates are rounded to 5 decimals and rings are oriented as RFC 7946 requires.
4. Each area gets a query outline for Qloo's `signal.location`: the outer ring of its largest part, reduced to at most 40 points (closing point included) without self-intersections.
5. The centroid of the largest part's outer ring (the display outline, before the reduction in step 4) and the geodesic area in km² are precomputed. Where that centroid falls outside the area, an interior point is used instead: the middle of the widest stretch of the area along the same line of latitude. This applies only to 37209, which wraps round a bend of the Cumberland River, so its centroid falls on the far bank in 37218.
6. Each area's id is `zcta_` and its ZIP (`zcta_37206`). Its display name is the ZIP area, such as "ZIP 37203", with a readable label in brackets where one applies. The label is the approximate alias from step 7 ("ZIP 37206 (East Nashville)"), or "Davidson part" for the eight ZIP areas that keep less than 90% of their area inside the county: 37015, 37027, 37064, 37072, 37086, 37122, 37135 and 37143. Without that label, the county's sliver of a suburban ZIP could be read as the whole town. "ZIP 37206" and "37206" are exact aliases.
7. Ten ZIP areas also answer to the name of the community they are commonly known by, such as East Nashville for 37206 or Antioch for 37013. A name is kept only where the place's point in the USGS Geographic Names Information System (GNIS, public domain) lies at least 300 m inside the ZIP area, and the package tests check each one. For Joelton, the GNIS point used is the former Joelton Air Force Station, because the populated-place point lies 30 m from the ZIP area's edge. ZIP and neighbourhood borders differ: a community's own borders can take in only part of its ZIP area, and part of the community can lie in a neighbouring ZIP area. Every such alias is therefore approximate, and the data marks each one as approximate (`approximateAliases`). Lift map captions say so: "U.S. Census Bureau 2020 ZIP Code Tabulation Areas clipped to Davidson County, public domain; neighbourhood names approximate".

| Approximate alias | ZIP area |
|---|---|
| East Nashville | 37206 |
| Inglewood | 37216 |
| Green Hills | 37215 |
| Donelson | 37214 |
| Antioch | 37013 |
| Hermitage | 37076 |
| Madison | 37115 |
| Old Hickory | 37138 |
| Bellevue | 37221 |
| Joelton | 37080 |

Hermitage is the community. The Hermitage, Andrew Jackson's home, lies in ZIP area 37138, so the name "The Hermitage" matches no area, while a point at the site is placed in 37138.

Some neighbourhoods sit inside a larger ZIP area, such as 12 South, Germantown, The Nations, Midtown, Wedgewood-Houston, Sylvan Park, Lockeland Springs and Five Points. They have no alias, so their names match no area, but a point inside one is still placed in its ZIP area.

### New York City

| | |
|---|---|
| Dataset | 2020 Neighborhood Tabulation Areas (NTAs), edition 26B of the Department of City Planning's BYTES of the BIG APPLE series. Each NTA also records the 2020 Community District Tabulation Area (CDTA) it belongs to. |
| Publisher | NYC Department of City Planning (DCP), on NYC Open Data (dataset `9nt8-h7nd`) |
| URL | <https://data.cityofnewyork.us/d/9nt8-h7nd> |
| Licence | No restrictions on use. Under New York City's Open Data Law, public data sets are made available without restrictions on their use (NYC Administrative Code § 23-502(d), enacted by Local Law 11 of 2012 and amended by Local Law 251 of 2017). The City may ask a user to name the data set's source and version and to describe any changes made to it, which this section does. The dataset names no other licence. DCP provides it for information only and gives no warranty of its completeness, accuracy, content or fitness for any purpose, and the NYC Open Data terms of use disclaim warranties in the same way. |
| Retrieved | 2026-10-23 (GeoJSON from the dataset's API) |
| Used in | `packages/geo/src/data/nyc-districts.ts` (the 59 community districts, which the app serves) and `packages/geo/src/data/nyc-ntas.ts` (the 197 tabulation areas), both built by `tools/geo/nyc.ts` |

DCP describes NTAs as approximations of New York City neighbourhoods, made for reporting Census and American Community Survey data. Each one is a group of 2020 census tracts. They are not meant to represent neighbourhoods definitively, and their names do not cover every name or understanding of a neighbourhood. CDTAs are groups of NTAs that approximate the city's 59 community districts, plus twelve Joint Interest Areas such as large parks and airports.

The app serves the community districts. Lift needs at least five map cells in an area, and at the map precision Qloo returned for Nashville, nearly half of the tabulation areas hold fewer than five, while every district holds at least five. The tabulation areas ship too, ready to serve if New York maps come back at a finer precision.

The approximate aliases (step 8) are checked against the USGS Geographic Names Information System (GNIS): the populated places in the domestic names file for New York State (`DomesticNames_NY`), public domain, retrieved 2026-10-23 from <https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/DomesticNames_NY_Text.zip>.

Transformations:

1. Of the 262 NTAs, the 197 residential ones (NTAType 0) are kept. DCP flags the other 65 as non-residential, with few or no residents: 40 parks, 14 cemeteries, 2 airports, Rikers Island and 8 other special areas, such as the Brooklyn Navy Yard, the United Nations, Sunnyside Yards and the military posts of Fort Hamilton and Fort Totten. They are left out, so a point inside one lies in no area, like a point outside the city. Lift maps leave their cells out of every neighbourhood.
2. Rings are repaired with [mapshaper](https://github.com/mbloch/mapshaper) (`-clean`). NTAs do not overlap, and no NTA lost more than 0.0001 km² to the repair. No NTA is under 0.1 km², so none is merged. Polygon parts and holes under 0.02 km², such as single piers, are dropped.
3. For the districts, the residential NTAs are dissolved by the CDTA each one records, which gives the 59 community districts. The Joint Interest Areas hold only non-residential NTAs, so none of them remains. A park or cemetery inside a district is left out of it as a hole or a notch.
4. The outlines are simplified with mapshaper (`-clean`, then Visvalingam at a 15 m interval with `keep-shapes`), the same step as Nashville's. Neighbouring areas keep the same border vertices. Coordinates are rounded to 5 decimals and rings are oriented as RFC 7946 requires. Both sets cover about 649 km². The districts have about 8,000 display vertices in a module of about 231 KB; the tabulation areas about 11,300 in one of about 424 KB.
5. Each area gets a query outline for Qloo's `signal.location`: the outer ring of its largest part, reduced to at most 40 points (closing point included) without self-intersections. Six tabulation areas have more than one part; their islands, such as Roosevelt Island, City Island and Broad Channel, lie outside the query outline. Seven districts have more than one part. In two of them a large part lies apart from the query outline: Douglaston-Little Neck, beyond Alley Pond Park, in Auburndale-Bayside-Douglaston, and Co-op City in Co-op City-Throgs Neck.
6. The centroid of the largest part's outer ring (the display outline, before the reduction in step 5) and the geodesic area in km² are precomputed. Where that centroid falls outside the area, an interior point is used instead, as for Nashville. This applies to two districts that wrap round cemeteries: East Flatbush and Ridgewood-Maspeth-Middle Village. Every tabulation area's centroid lies inside it.
7. Display names are the names as published. A tabulation area keeps its NTA name, such as "SoHo-Little Italy-Hudson Square" or "Bedford-Stuyvesant (West)". A district takes its CDTA name without the code and the "(CD 1 Equivalent)" or "(CD 2 Approximation)" suffix, such as "Williamsburg-Greenpoint" or "Crown Heights (North)". Each id is a slug of the name (`soho_little_italy_hudson_square`, `williamsburg_greenpoint`).
8. An NTA name lists the places it joins, separated by hyphens. Bedford-Stuyvesant and Co-op City are single places. These places become approximate aliases, and the package tests check each one:
   - A tabulation area answers to each place its name lists, except one with a bracketed qualifier such as "(North)", which names only part of a place. A name that is a single place is the area's own name.
   - A district answers to every place its tabulation areas list, and to the base name of a place DCP splits, such as Bushwick for "Bushwick (West)" and "Bushwick (East)".
   - The name must belong to this area alone: no other area's NTAs, residential or not, list it, with or without a qualifier. So Astoria and Harlem name a district but no tabulation area, and Murray Hill, listed in Manhattan and in Queens, names neither.
   - A name GNIS gives to a place outside the city within 5 km of the area is left out, because it means that suburb: Floral Park and New Hyde Park, villages in Nassau County. This does not apply where an NTA bears the name alone, such as Bellerose. Places of the same name farther away, in the city or not, such as Chelsea on Staten Island, do not count.
   - The place must lie in the part of the area that Block DNA sends. A place listed by an NTA of a single part qualifies when that NTA's label point lies inside the area's query outline. A place listed only by an NTA of several parts needs a GNIS point inside the query outline, at least 150 m from the area's border. So Roosevelt Island and Lenox Hill, which have no GNIS populated place, and City Island and Broad Channel, whose GNIS points lie on island parts, are no aliases. Co-op City, Douglaston and Little Neck are no district aliases, because they lie apart from their district's query outline.

   The tabulation areas have 173 approximate aliases and the districts 293, listed below. A place's own borders can differ from its area's, so every such alias is approximate (`approximateAliases`). Places that fail stay unmatched, but points inside them are still placed.

| Tabulation area | Approximate aliases |
|---|---|
| Annadale-Huguenot-Prince's Bay-Woodrow | Annadale, Huguenot, Prince's Bay, Woodrow |
| Arden Heights-Rossville | Arden Heights, Rossville |
| Astoria (North)-Ditmars-Steinway | Ditmars, Steinway |
| Bay Terrace-Clearview | Bay Terrace, Clearview |
| Breezy Point-Belle Harbor-Rockaway Park-Broad Channel | Belle Harbor, Rockaway Park |
| Carroll Gardens-Cobble Hill-Gowanus-Red Hook | Carroll Gardens, Cobble Hill, Gowanus, Red Hook |
| Castle Hill-Unionport | Unionport |
| Chelsea-Hudson Yards | Chelsea, Hudson Yards |
| Chinatown-Two Bridges | Chinatown, Two Bridges |
| Claremont Village-Claremont (East) | Claremont Village |
| Concourse-Concourse Village | Concourse, Concourse Village |
| Coney Island-Sea Gate | Coney Island, Sea Gate |
| Douglaston-Little Neck | Douglaston, Little Neck |
| Downtown Brooklyn-DUMBO-Boerum Hill | Downtown Brooklyn, DUMBO, Boerum Hill |
| East Flatbush-Erasmus | Erasmus |
| East Flatbush-Farragut | Farragut |
| East Flatbush-Remsen Village | Remsen Village |
| East Flatbush-Rugby | Rugby |
| East Midtown-Turtle Bay | East Midtown, Turtle Bay |
| East New York-City Line | City Line |
| East New York-New Lots | New Lots |
| Eastchester-Edenwald-Baychester | Eastchester, Edenwald, Baychester |
| Far Rockaway-Bayswater | Far Rockaway, Bayswater |
| Financial District-Battery Park City | Financial District, Battery Park City |
| Flatbush (West)-Ditmas Park-Parkville | Ditmas Park, Parkville |
| Flushing-Willets Point | Flushing, Willets Point |
| Fresh Meadows-Utopia | Fresh Meadows, Utopia |
| Glen Oaks-Floral Park-New Hyde Park | Glen Oaks |
| Grasmere-Arrochar-South Beach-Dongan Hills | Grasmere, Arrochar, South Beach, Dongan Hills |
| Gravesend (East)-Homecrest | Homecrest |
| Great Kills-Eltingville | Great Kills, Eltingville |
| Hamilton Heights-Sugar Hill | Hamilton Heights, Sugar Hill |
| Howard Beach-Lindenwood | Howard Beach, Lindenwood |
| Jamaica Estates-Holliswood | Jamaica Estates, Holliswood |
| Jamaica Hills-Briarwood | Jamaica Hills, Briarwood |
| Kingsbridge Heights-Van Cortlandt Village | Kingsbridge Heights, Van Cortlandt Village |
| Kingsbridge-Marble Hill | Kingsbridge, Marble Hill |
| Long Island City-Hunters Point | Long Island City, Hunters Point |
| Manhattanville-West Harlem | Manhattanville, West Harlem |
| Mapleton-Midwood (West) | Mapleton |
| Marine Park-Mill Basin-Bergen Beach | Mill Basin, Bergen Beach |
| Mariner's Harbor-Arlington-Graniteville | Mariner's Harbor, Arlington, Graniteville |
| Midtown South-Flatiron-Union Square | Midtown South, Flatiron, Union Square |
| Midtown-Times Square | Midtown, Times Square |
| Mott Haven-Port Morris | Mott Haven, Port Morris |
| Mount Eden-Claremont (West) | Mount Eden |
| Murray Hill-Broadway Flushing | Broadway Flushing |
| Murray Hill-Kips Bay | Kips Bay |
| New Dorp-Midland Beach | New Dorp, Midland Beach |
| New Springville-Willowbrook-Bulls Head-Travis | New Springville, Willowbrook, Bulls Head, Travis |
| Oakland Gardens-Hollis Hills | Oakland Gardens, Hollis Hills |
| Oakwood-Richmondtown | Oakwood, Richmondtown |
| Old Astoria-Hallets Point | Old Astoria, Hallets Point |
| Pelham Bay-Country Club-City Island | Country Club |
| Pelham Parkway-Van Nest | Pelham Parkway, Van Nest |
| Pomonok-Electchester-Hillcrest | Pomonok, Electchester, Hillcrest |
| Prospect Lefferts Gardens-Wingate | Prospect Lefferts Gardens, Wingate |
| Queensbridge-Ravenswood-Dutch Kills | Queensbridge, Ravenswood, Dutch Kills |
| Riverdale-Spuyten Duyvil | Riverdale, Spuyten Duyvil |
| Rockaway Beach-Arverne-Edgemere | Rockaway Beach, Arverne, Edgemere |
| Rosebank-Shore Acres-Park Hill | Rosebank, Shore Acres, Park Hill |
| Sheepshead Bay-Manhattan Beach-Gerritsen Beach | Sheepshead Bay, Manhattan Beach, Gerritsen Beach |
| SoHo-Little Italy-Hudson Square | SoHo, Little Italy, Hudson Square |
| Soundview-Bruckner-Bronx River | Bruckner, Bronx River |
| Soundview-Clason Point | Clason Point |
| Spring Creek-Starrett City | Spring Creek, Starrett City |
| Springfield Gardens (North)-Rochdale Village | Rochdale Village |
| Springfield Gardens (South)-Brookville | Brookville |
| St. George-New Brighton | St. George, New Brighton |
| Stuyvesant Town-Peter Cooper Village | Stuyvesant Town, Peter Cooper Village |
| Throgs Neck-Schuylerville | Throgs Neck, Schuylerville |
| Todt Hill-Emerson Hill-Lighthouse Hill-Manor Heights | Todt Hill, Emerson Hill, Lighthouse Hill, Manor Heights |
| Tompkinsville-Stapleton-Clifton-Fox Hills | Tompkinsville, Stapleton, Clifton, Fox Hills |
| Tottenville-Charleston | Tottenville, Charleston |
| Tribeca-Civic Center | Tribeca, Civic Center |
| University Heights (North)-Fordham | Fordham |
| University Heights (South)-Morris Heights | Morris Heights |
| Upper East Side-Carnegie Hill | Carnegie Hill |
| Upper East Side-Yorkville | Yorkville |
| Upper West Side-Lincoln Square | Lincoln Square |
| Upper West Side-Manhattan Valley | Manhattan Valley |
| Wakefield-Woodlawn | Wakefield, Woodlawn |
| West New Brighton-Silver Lake-Grymes Hill | West New Brighton, Silver Lake, Grymes Hill |
| Westerleigh-Castleton Corners | Westerleigh, Castleton Corners |
| Whitestone-Beechhurst | Whitestone, Beechhurst |
| Williamsbridge-Olinville | Williamsbridge, Olinville |
| Windsor Terrace-South Slope | Windsor Terrace, South Slope |

| District | Approximate aliases |
|---|---|
| Astoria-Queensbridge | Astoria (North), Astoria, Ditmars, Steinway, Old Astoria, Hallets Point, Astoria (Central), Astoria (East), Woodside (North), Queensbridge, Ravenswood, Dutch Kills |
| Auburndale-Bayside-Douglaston | Auburndale, Bayside, Oakland Gardens, Hollis Hills |
| Bay Ridge-Dyker Heights | Bay Ridge, Dyker Heights |
| Bedford-Stuyvesant | Bedford-Stuyvesant (West), Bedford-Stuyvesant (East) |
| Bensonhurst-Bath Beach | Bensonhurst, Bath Beach, Gravesend (West) |
| Borough Park-Kensington | Sunset Park (East), Borough Park (West), Borough Park, Kensington, Mapleton, Midwood (West) |
| Bushwick | Bushwick (West), Bushwick (East) |
| Canarsie-Flatlands | Flatlands, Marine Park, Mill Basin, Bergen Beach, Canarsie |
| Chelsea-Hell's Kitchen | Chelsea, Hudson Yards, Hell's Kitchen |
| Co-op City-Throgs Neck | Westchester Square, Throgs Neck, Schuylerville, Pelham Bay, Country Club |
| Coney Island-Brighton Beach | Gravesend (South), Coney Island, Sea Gate, Brighton Beach |
| Crown Heights (North) | Prospect Heights |
| Crown Heights (South) | Prospect Lefferts Gardens, Wingate |
| Downtown Brooklyn-Fort Greene | Brooklyn Heights, Downtown Brooklyn, DUMBO, Boerum Hill, Fort Greene, Clinton Hill |
| East Flatbush | Erasmus, Farragut, Rugby, Remsen Village |
| East Harlem | East Harlem (South), East Harlem (North) |
| East Midtown-Murray Hill | Stuyvesant Town, Peter Cooper Village, Gramercy, Kips Bay, East Midtown, Turtle Bay |
| East New York-Cypress Hills | Cypress Hills, East New York (North), East New York, New Lots, Spring Creek, Starrett City, City Line |
| Elmhurst-Corona | Elmhurst, Corona |
| Financial District-Tribeca | Financial District, Battery Park City, Tribeca, Civic Center |
| Flatbush-Midwood | Flatbush, Flatbush (West), Ditmas Park, Parkville |
| Flushing-Murray Hill-Whitestone | College Point, Whitestone, Beechhurst, Bay Terrace, Clearview, Broadway Flushing, East Flushing, Queensboro Hill, Flushing, Willets Point |
| Fordham-Bedford Park-Norwood | University Heights (North), Fordham, Bedford Park, Norwood |
| Forest Hills-Rego Park | Rego Park, Forest Hills |
| Fresh Meadows-Hillcrest-Briarwood | Kew Gardens Hills, Pomonok, Electchester, Hillcrest, Fresh Meadows, Utopia, Jamaica Estates, Holliswood, Jamaica Hills, Briarwood |
| Greenwich Village-SoHo | SoHo, Little Italy, Hudson Square, Greenwich Village, West Village |
| Harlem | Harlem (South), Harlem (North) |
| Highbridge-Concourse | Concourse, Concourse Village, Highbridge, Mount Eden, Claremont (West) |
| Jackson Heights-East Elmhurst | Jackson Heights, East Elmhurst, North Corona |
| Jamaica-St. Albans-Hollis | Jamaica, South Jamaica, Baisley Park, Springfield Gardens (North), Rochdale Village, St. Albans, Hollis |
| Kew Gardens-Richmond Hill-Woodhaven | Kew Gardens, Richmond Hill, South Richmond Hill, Ozone Park (North), Woodhaven |
| Long Island City-Sunnyside-Woodside | Long Island City, Hunters Point, Sunnyside |
| Longwood-Hunts Point | Hunts Point, Longwood |
| Lower East Side-Chinatown | Chinatown, Two Bridges, Lower East Side, East Village |
| Melrose-Mott Haven-Port Morris | Mott Haven, Port Morris, Melrose |
| Mid-Island | Grasmere, Arrochar, South Beach, Dongan Hills, New Dorp, Midland Beach, Todt Hill, Emerson Hill, Lighthouse Hill, Manor Heights, New Springville, Willowbrook, Bulls Head, Travis |
| Midtown-Flatiron-Union Square | Midtown South, Flatiron, Union Square, Midtown, Times Square |
| Morningside Heights-Hamilton Heights | Morningside Heights, Manhattanville, West Harlem, Hamilton Heights, Sugar Hill |
| Morris Heights-Mount Hope | University Heights (South), Morris Heights, Mount Hope, Fordham Heights |
| Morrisania-Crotona Park East | Morrisania, Claremont Village, Claremont (East), Crotona Park East |
| North Shore | St. George, New Brighton, Tompkinsville, Stapleton, Clifton, Fox Hills, Rosebank, Shore Acres, Park Hill, West New Brighton, Silver Lake, Grymes Hill, Westerleigh, Castleton Corners, Port Richmond, Mariner's Harbor, Arlington, Graniteville |
| Ocean Hill-Brownsville | Ocean Hill, Brownsville |
| Park Slope-Carroll Gardens | Carroll Gardens, Cobble Hill, Gowanus, Red Hook, Park Slope |
| Pelham Parkway-Morris Park | Pelham Parkway, Van Nest, Morris Park, Pelham Gardens, Allerton |
| Queens Village-Bellerose-Rosedale | Glen Oaks, Bellerose, Queens Village, Cambria Heights, Laurelton, Springfield Gardens (South), Brookville, Rosedale |
| Ridgewood-Maspeth-Middle Village | Maspeth, Ridgewood, Glendale, Middle Village |
| Riverdale-Kingsbridge-Marble Hill | Kingsbridge Heights, Van Cortlandt Village, Kingsbridge, Marble Hill, Riverdale, Spuyten Duyvil |
| Sheepshead Bay-Gravesend (East) | Gravesend (East), Homecrest, Madison, Sheepshead Bay, Manhattan Beach, Gerritsen Beach |
| Soundview-Parkchester | Soundview, Bruckner, Bronx River, Clason Point, Unionport, Parkchester |
| South Ozone Park-Howard Beach | South Ozone Park, Howard Beach, Lindenwood |
| South Shore | Oakwood, Richmondtown, Great Kills, Eltingville, Arden Heights, Rossville, Annadale, Huguenot, Prince's Bay, Woodrow, Tottenville, Charleston |
| Sunset Park-Windsor Terrace | Windsor Terrace, South Slope, Sunset Park (West), Sunset Park (Central) |
| The Rockaways | Far Rockaway, Bayswater, Rockaway Beach, Arverne, Edgemere, Belle Harbor, Rockaway Park |
| Tremont-Belmont-West Farms | West Farms, Tremont, Belmont |
| Upper East Side-Roosevelt Island | Upper East Side, Carnegie Hill, Yorkville |
| Upper West Side | Lincoln Square, Upper West Side (Central), Manhattan Valley |
| Wakefield-Williamsbridge-Eastchester | Williamsbridge, Olinville, Eastchester, Edenwald, Baychester, Wakefield, Woodlawn |
| Washington Heights-Inwood | Washington Heights (South), Washington Heights, Washington Heights (North), Inwood |
| Williamsburg-Greenpoint | Greenpoint, Williamsburg, South Williamsburg, East Williamsburg |

### ZIP areas for further metros

A metro without a neighbourhood set published under an open licence can use ZIP areas built by `tools/geo/zcta.ts`, the way Nashville's were. The build clips the Census Bureau's 2020 ZIP Code Tabulation Areas to the metro's 2020 county outlines. Both come from the TIGERweb map service (Census 2020 layers 84 and 82) or from the TIGER/Line files (<https://www2.census.gov/geo/tiger/TIGER2020/ZCTA520/> and <https://www2.census.gov/geo/tiger/TIGER2020/COUNTY/>). Like Nashville's, they are public domain as works of the U.S. Government (17 U.S.C. § 105). The build applies Nashville's steps 1 to 6 and adds any approximate aliases from a table given to it; Nashville's is `tools/geo/nashville-aliases.json`, so the build reproduces its ZIP areas. Each metro built this way gets its own section here, with its counties, retrieval date and aliases.

The ten ZIP-area map cities below (D39) were built this way: Los Angeles, Chicago, Miami, San Francisco, Seattle, Boston, Denver, Atlanta, Houston and Dallas. They use the TIGERweb Census 2020 layers 84 (Zip Code Tabulation Areas) and 82 (Counties), retrieved 2026-10-27 as GeoJSON from each layer's query endpoint, January 1, 2020 vintage, public domain (17 U.S.C. § 105). Each applies Nashville's steps 1 to 6 to its counties, at the simplification interval its section gives. Their approximate aliases come from a table per city (`tools/geo/<city>-aliases.json`) and are checked against the USGS Geographic Names Information System (GNIS), public domain: the populated places in the state's domestic names file, retrieved 2026-10-27 from <https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/> (`DomesticNames_<ST>_Text.zip`). A name becomes an alias only when all of these hold:

- the ZIP area is commonly known by that neighbourhood, community or town; a city that spans several ZIP areas is no alias, but a city that is one ZIP area, such as Malibu, Key Biscayne or Mercer Island, counts as a community;
- a GNIS populated place of that name lies inside the ZIP area's query outline, the part Block DNA sends, at least 300 m from its border, as for Nashville; for Boston, Denver, Atlanta, Houston and Dallas, 150 m in a ZIP area under 5 km² and 100 m in one under 1 km², since a dense core's ZIP areas are too small for 300 m;
- no GNIS place of that name lies in another ZIP area of the map, or outside the counties within 5 km;
- no other area already answers to that name.

The ZIP area's display label is its first alias. Every alias is approximate (`approximateAliases`), as Nashville's are, and lift map captions say "neighbourhood names approximate". GNIS has no populated-place point for many inner-city neighbourhoods, such as Wynwood, Boston's South End, Denver's LoDo, Atlanta's Midtown, Houston's Montrose and Dallas's Deep Ellum: those names match no area, but a point inside one is still placed in its ZIP area. ZCTAs are not ZIP Codes, so the ZIP Code of a street address can differ from the ZCTA it lies in.

#### Los Angeles

| | |
|---|---|
| Dataset | 2020 Census ZIP Code Tabulation Areas (ZCTAs), and the 2020 Census outline of Los Angeles County, California (GEOID 06037), January 1, 2020 vintage |
| Publisher | U.S. Census Bureau, through its TIGERweb map service (layers 84 and 82, as for Nashville) |
| URL | <https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer> |
| Licence | Public domain (17 U.S.C. § 105) |
| Aliases checked against | USGS GNIS, `DomesticNames_CA` (California), public domain |
| Retrieved | 2026-10-27 (GeoJSON from the two layers' query endpoints; the GNIS file the same day) |
| Used in | `packages/geo/src/data/los-angeles.ts`, built by `tools/geo/zcta.ts --metro los_angeles --label "Los Angeles County" --county 06037 --aliases tools/geo/los-angeles-aliases.json --interval 85 --out packages/geo/src/data/los-angeles.ts` |

Transformations:

1. The 414 ZCTAs that meet a box around the county are clipped to the Los Angeles County outline. 110 lie wholly outside the county and are left out. Four cross the county line with less than 1 km² inside and are left out as slivers: 90623, 90630, 90740 and 91709. Fifteen cross the county line and keep only their part inside it.
2. Rings are repaired, and polygon parts and holes under 0.02 km² are dropped. Four ZIP areas under 0.1 km² are merged into the neighbour they share the longest border with, which then also answers to their ZIPs: 91046 into 91214, 90079 into 90015, 90747 into 90746, and 90831 into 90802. The 296 ZIP areas cover about 10,236 km². The county's outline also takes in open water, which no ZCTA covers. The largest ZIP area, 90704 (about 765 km² with its water), holds Santa Catalina Island and, as a second part, the northern tip of San Clemente Island. The rest of San Clemente Island lies in no ZCTA.
3. The outlines are simplified with mapshaper (`-clean`, then Visvalingam at an 85 m interval with `keep-shapes`). Los Angeles has eight times Nashville's ZIP areas, and many of them are large desert and mountain ZIP areas, so a coarser step keeps the module to about 582 KB (about 14,200 display vertices). At 90 m and above, ZIP area 90840 (California State University, Long Beach) shrinks below 0.1 km². Neighbouring areas keep the same border vertices. Coordinates are rounded to 5 decimals, and rings are oriented as RFC 7946 requires.
4. Each area gets a query outline for Qloo's `signal.location`: the outer ring of its largest part, reduced to at most 40 points (closing point included) without self-intersections.
5. Centroids and geodesic areas are precomputed as for Nashville. Six areas have an area-weighted centroid that falls outside them and use an interior point instead: 90007, 90274, 91355, 91390, 93532 and 93563.
6. Ids and names follow Nashville's pattern (`zcta_90026`, "ZIP 90026"). "Los Angeles part" labels the nine ZIP areas that keep less than 90% of their area inside the county: 90631, 91304, 91307, 91361, 91362, 91759, 92397, 93243 and 93560. ZIP area 90265 keeps 70% and carries its alias as its label instead: "ZIP 90265 (Malibu)". The City of Malibu lies wholly inside the county.
7. 46 approximate aliases on 42 ZIP areas, each with its GNIS populated-place point at least 300 m inside:

| Approximate alias | ZIP area |
|---|---|
| Baldwin Hills, Leimert Park | 90008 |
| West Los Angeles | 90025 |
| Hollywood | 90028 |
| Lincoln Heights | 90031 |
| El Sereno | 90032 |
| Palms | 90034 |
| Eagle Rock | 90041 |
| Highland Park | 90042 |
| Westchester | 90045 |
| Brentwood | 90049 |
| Glassell Park, Mount Washington, Cypress Park | 90065 |
| Mar Vista | 90066 |
| Bel Air | 90077 |
| Malibu | 90265 |
| Pacific Palisades | 90272 |
| Topanga | 90290 |
| Venice | 90291 |
| Marina del Rey | 90292 |
| Playa del Rey | 90293 |
| Harbor City | 90710 |
| San Pedro | 90731 |
| Wilmington | 90744 |
| Belmont Shore | 90803 |
| Bixby Knolls | 90807 |
| Altadena | 91001 |
| Tujunga | 91042 |
| La Crescenta | 91214 |
| Canoga Park | 91303 |
| Winnetka | 91306 |
| Chatsworth | 91311 |
| Pacoima | 91331 |
| Reseda | 91335 |
| Sylmar, Lake View Terrace | 91342 |
| North Hills | 91343 |
| Mission Hills | 91345 |
| Sun Valley | 91352 |
| Tarzana | 91356 |
| Panorama City | 91402 |
| Lake Balboa | 91406 |
| North Hollywood | 91601 |
| Studio City | 91604 |
| Universal City | 91608 |

Some well-known names fail the rule and match no area. A point inside one is still placed in its ZIP area. GNIS puts Koreatown 210 m from the edge of 90005, Echo Park 80 m inside 90039 (it is mostly 90026), Westwood 255 m inside 90024, Watts 265 m inside 90002, Little Tokyo 100 m inside 90012, and Boyle Heights, Sherman Oaks, Encino, Van Nuys and Woodland Hills within 60 m of a ZIP border. GNIS has no populated place for Silver Lake, Los Feliz, Downtown, Toluca Lake, Porter Ranch or West Hills. Atwater passes the rule in 90039, but it is left out: the neighbourhood is called Atwater Village, and 90039 is as much Silver Lake. Cities that span several ZIP areas, such as Santa Monica, Pasadena, West Hollywood and Long Beach, are not aliases.

#### Chicago

| | |
|---|---|
| Dataset | 2020 Census ZCTAs, and the 2020 Census outline of Cook County, Illinois (GEOID 17031), January 1, 2020 vintage |
| Publisher | U.S. Census Bureau, through its TIGERweb map service (layers 84 and 82) |
| URL | <https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer> |
| Licence | Public domain (17 U.S.C. § 105) |
| Aliases checked against | USGS GNIS, `DomesticNames_IL` (Illinois), public domain |
| Retrieved | 2026-10-27 |
| Used in | `packages/geo/src/data/chicago.ts`, built by `tools/geo/zcta.ts --metro chicago --label "Cook County" --county 17031 --aliases tools/geo/chicago-aliases.json --interval 20 --out packages/geo/src/data/chicago.ts` |

Transformations:

1. The 270 ZCTAs that meet a box around the county are clipped to the Cook County outline. 92 lie wholly outside it and are left out. Two are left out as slivers under 1 km² inside: 60126 and 60523. Twenty-one cross the county line and keep only their part inside.
2. Rings are repaired and slivers dropped as for Nashville. No ZIP area is under 0.1 km², so none is merged. The 176 ZIP areas cover about 2,511 km². The county's outline also takes in part of Lake Michigan, which no ZCTA covers.
3. Simplified at a 20 m interval: about 486 KB, about 14,650 display vertices.
4. Query outlines as for Nashville.
5. One area-weighted centroid falls outside its area and is replaced by an interior point: 60192.
6. "Cook part" labels the fifteen ZIP areas that keep less than 90% of their area inside the county: 60010, 60015, 60089, 60103, 60120, 60133, 60172, 60423, 60439, 60449, 60466, 60475, 60487, 60521 and 60527.
7. 33 approximate aliases on 29 ZIP areas, all Chicago community areas or neighbourhoods:

| Approximate alias | ZIP area |
|---|---|
| Pilsen, Bridgeport | 60608 |
| Back of the Yards | 60609 |
| Near North Side | 60610 |
| Streeterville | 60611 |
| Lincoln Park | 60614 |
| Chinatown | 60616 |
| South Chicago | 60617 |
| Avondale | 60618 |
| Chatham | 60619 |
| Englewood | 60621 |
| West Town | 60622 |
| West Garfield Park | 60624 |
| Albany Park | 60625 |
| Rogers Park | 60626 |
| Roseland, Pullman | 60628 |
| Chicago Lawn | 60629 |
| Jefferson Park | 60630 |
| Brighton Park | 60632 |
| Hegewisch | 60633 |
| Woodlawn | 60637 |
| Irving Park | 60641 |
| Beverly, Morgan Park | 60643 |
| Austin | 60644 |
| Sauganash, Edgebrook | 60646 |
| Logan Square | 60647 |
| South Shore | 60649 |
| Humboldt Park | 60651 |
| Ashburn | 60652 |
| Mount Greenwood | 60655 |

Some well-known names fail the rule. GNIS puts Hyde Park 102 m inside 60637 (on its border with 60615, since both are Hyde Park), Uptown 125 m inside 60640, Gold Coast 254 m inside 60610, Bronzeville and Kenwood within 20 m of a border, and the Loop 95 m inside 60603. GNIS's only Lake View in Cook County is in Glenview (60093), not the Chicago neighbourhood. It has no populated place for Wicker Park, Bucktown, Wrigleyville, Andersonville, Old Town, West Loop or River North. Other names pass the rule but would mislabel a ZIP area mostly known by another name, so they are left out: Buena Park (60613 is Lakeview), Ravenswood (60640 is Uptown), and Galewood and Montclare (60707 is mostly Elmwood Park).

#### Miami

| | |
|---|---|
| Dataset | 2020 Census ZCTAs, and the 2020 Census outline of Miami-Dade County, Florida (GEOID 12086), January 1, 2020 vintage |
| Publisher | U.S. Census Bureau, through its TIGERweb map service (layers 84 and 82) |
| URL | <https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer> |
| Licence | Public domain (17 U.S.C. § 105) |
| Aliases checked against | USGS GNIS, `DomesticNames_FL` (Florida), public domain |
| Retrieved | 2026-10-27 |
| Used in | `packages/geo/src/data/miami.ts`, built by `tools/geo/zcta.ts --metro miami --label "Miami-Dade County" --county 12086 --aliases tools/geo/miami-aliases.json --interval 15 --out packages/geo/src/data/miami.ts` |

Transformations:

1. The 88 ZCTAs that meet a box around the county are clipped to the Miami-Dade County outline. Seven lie wholly outside it and are left out. Two cross the county line and keep only their part inside.
2. One ZIP area under 0.1 km², 33101 (about 0.035 km²), is merged into 33136, which also answers to "ZIP 33101" and "33101". The 80 ZIP areas cover about 4,154 km², including the Everglades and Florida Bay parts of 33034, which is the largest at about 1,704 km².
3. Simplified at a 15 m interval, Nashville's step: about 312 KB, about 11,070 display vertices.
4. Query outlines as for Nashville.
5. Every area-weighted centroid lies inside its area.
6. "Miami-Dade part" labels the two ZIP areas that keep less than 90% of their area inside the county: 33034 and 34141.
7. Eight approximate aliases on eight ZIP areas:

| Approximate alias | ZIP area |
|---|---|
| Redland | 33031 |
| Fisher Island | 33109 |
| Coconut Grove | 33133 |
| Little Havana | 33135 |
| Allapattah | 33142 |
| Flagami | 33144 |
| Key Biscayne | 33149 |
| Kendall | 33156 |

GNIS has no populated place for Wynwood, Little Haiti, Overtown, Edgewater, the Design District, Midtown or South Beach. It puts Brickell Hammock 269 m inside 33129 and Westchester 64 m inside 33155. Cities that span several ZIP areas, such as Miami Beach, Coral Gables, Hialeah, Doral and Aventura, are not aliases.

#### San Francisco

| | |
|---|---|
| Dataset | 2020 Census ZCTAs, and the 2020 Census outline of San Francisco County, California (GEOID 06075), January 1, 2020 vintage |
| Publisher | U.S. Census Bureau, through its TIGERweb map service (layers 84 and 82) |
| URL | <https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer> |
| Licence | Public domain (17 U.S.C. § 105) |
| Aliases checked against | USGS GNIS, `DomesticNames_CA` (California), public domain |
| Retrieved | 2026-10-27 |
| Used in | `packages/geo/src/data/san-francisco.ts`, built by `tools/geo/zcta.ts --metro san_francisco --label "San Francisco County" --county 06075 --aliases tools/geo/san-francisco-aliases.json --interval 15 --out packages/geo/src/data/san-francisco.ts` |

Transformations:

1. The 55 ZCTAs that meet a box around the county are clipped to the San Francisco County outline. 25 lie wholly outside it and are left out. Two are left out as slivers under 1 km² inside: 94501 (Alameda) and 94920 (Belvedere Tiburon), which reach the county line in the bay. No ZIP area keeps only part of itself, so none is labelled as a part.
2. No ZIP area is under 0.1 km². The 28 ZIP areas cover about 130.5 km², including the Presidio (94129) and Treasure and Yerba Buena Islands (94130). The county's outline also takes in bay and ocean water and the Farallon Islands, which no ZCTA covers.
3. Simplified at a 15 m interval: about 87 KB, about 2,640 display vertices.
4. Query outlines as for Nashville.
5. Two area-weighted centroids fall outside their areas and are replaced by interior points: 94105 and 94107.
6. Ids and names as for Nashville.
7. Seven approximate aliases on seven ZIP areas:

| Approximate alias | ZIP area |
|---|---|
| Potrero District | 94107 |
| Mission District | 94110 |
| Ingleside | 94112 |
| Haight-Ashbury | 94117 |
| Marina District | 94123 |
| Bayview District | 94124 |
| North Beach | 94133 |

The name matcher drops a trailing "district", so "the Mission District", "Mission District" and "Mission" all match 94110. GNIS puts the Richmond District 279 m inside 94118, the Sunset District 222 m inside 94122 and Chinatown 89 m inside 94133. Its Pacific Heights point lies in 94118, in what is locally Presidio Heights, so it is left out. GNIS has no populated place for SoMa, the Castro, Nob Hill, Noe Valley, the Tenderloin, Hayes Valley or Dogpatch.

#### Seattle

| | |
|---|---|
| Dataset | 2020 Census ZCTAs, and the 2020 Census outline of King County, Washington (GEOID 53033), January 1, 2020 vintage |
| Publisher | U.S. Census Bureau, through its TIGERweb map service (layers 84 and 82) |
| URL | <https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer> |
| Licence | Public domain (17 U.S.C. § 105) |
| Aliases checked against | USGS GNIS, `DomesticNames_WA` (Washington), public domain |
| Retrieved | 2026-10-27 |
| Used in | `packages/geo/src/data/seattle.ts`, built by `tools/geo/zcta.ts --metro seattle --label "King County" --county 53033 --aliases tools/geo/seattle-aliases.json --interval 20 --out packages/geo/src/data/seattle.ts` |

Transformations:

1. The 153 ZCTAs that meet a box around the county are clipped to the King County outline. 64 lie wholly outside it and are left out. One is left out as a sliver under 1 km² inside: 98422. Seven cross the county line and keep only their part inside.
2. Three downtown ZIP areas under 0.1 km² are merged into 98104, which also answers to their ZIPs: 98154, 98164 and 98174. The 85 ZIP areas cover about 5,719 km², including the Cascade foothills and mountains. The largest is 98022 (Enumclaw, King part) at about 1,164 km².
3. Simplified at a 20 m interval: about 490 KB, about 18,480 display vertices.
4. Query outlines as for Nashville.
5. Every area-weighted centroid lies inside its area.
6. "King part" labels the six ZIP areas that keep less than 90% of their area inside the county: 98022, 98047, 98068, 98072, 98077 and 98354.
7. 23 approximate aliases on 14 ZIP areas:

| Approximate alias | ZIP area |
|---|---|
| Mercer Island | 98040 |
| Vashon | 98070 |
| Capitol Hill | 98102 |
| Green Lake | 98103 |
| Georgetown, South Park | 98108 |
| Madison Park, Montlake | 98112 |
| Ravenna, Wedgwood, Maple Leaf | 98115 |
| West Seattle, Alki | 98116 |
| Columbia City, Rainier Beach, Seward Park | 98118 |
| Queen Anne | 98119 |
| Lake City, Northgate | 98125 |
| Fauntleroy | 98136 |
| Beacon Hill, Mount Baker | 98144 |
| Skyway | 98178 |

GNIS has a second Georgetown in King County, near Ravensdale (98051). As in New York's rule, a namesake elsewhere in the city's own county does not block a name. Seattle's Georgetown point lies 431 m inside 98108. Several well-known names fail the rule. GNIS puts Ballard and Fremont on a ZIP border, Belltown 232 m inside 98121, Wallingford 58 m inside 98105, the University District 23 m inside 98195 and Greenwood 152 m inside 98103. GNIS has no populated place for South Lake Union, Magnolia or the Central District. Other names pass the rule but are left out because their ZIP area is mostly known by another name: Crown Hill (98117 is Ballard), Interbay (98199 is Magnolia), Laurelhurst (98105 is the University District), Madrona (98122 is the Central District), and Haller Lake and Bitter Lake (98133). Cities that span several ZIP areas, such as Bellevue, Redmond, Kirkland and Renton, are not aliases.

#### Boston

No neighbourhood boundary set for Boston is used. Boston uses ZIP areas: the Census Bureau's ZIP Code Tabulation Areas, clipped to Suffolk County, which is the cities of Boston, Chelsea and Revere and the town of Winthrop.

| | |
|---|---|
| Dataset | 2020 Census ZIP Code Tabulation Areas (ZCTAs), and the 2020 Census outline of Suffolk County, Massachusetts (GEOID 25025), January 1, 2020 vintage |
| Publisher | U.S. Census Bureau, through its TIGERweb map service (layers credited as for Nashville) |
| URL | <https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer>, layer 84 (Zip Code Tabulation Areas) and layer 82 (Counties) |
| Licence | Public domain (17 U.S.C. § 105) |
| Retrieved | 2026-10-27 (GeoJSON from the two layers' query endpoints) |
| Used in | `packages/geo/src/data/boston.ts`, built with `tools/geo/boston-aliases.json` |

Transformations:

1. The 79 ZCTAs that meet a box around the county are clipped to the Suffolk County outline. 40 lie wholly outside and are left out, and 3 keep less than 1 km² inside (02149, 02445 and 02446) and are left out as slivers. 02215 keeps 96% of its area and 02467 14%. The result is 36 ZIP areas.
2. As Nashville's step 2. Two downtown ZCTAs under 0.1 km² are merged into 02108, which also answers to their ZIPs: 02133 (0.034 km², the State House block) and 02203 (0.025 km², a downtown block). The 34 ZIP areas cover about 166 km². ZCTAs leave out most of the harbour, so this is about the county's land area, not its 311 km² outline.
3. As Nashville's step 3, at a 15 m interval: about 107 KB, 3,398 display vertices.
4. to 6. As Nashville's. The area-weighted centroid of 02115 lies outside it, so an interior point is used. 02467, mostly in Newton and Brookline, keeps 14% of its area and is labelled "Suffolk part".
7. Nineteen ZIP areas answer to an approximate alias:

| Approximate alias | ZIP area |
|---|---|
| North End | 02113 |
| Roxbury | 02119 |
| Grove Hall | 02121 |
| Fields Corner | 02122 |
| Dorchester Center | 02124 |
| Uphams Corner | 02125 |
| Mattapan | 02126 |
| South Boston | 02127 |
| East Boston | 02128 |
| Charlestown | 02129 |
| Jamaica Plain | 02130 |
| Roslindale | 02131 |
| West Roxbury | 02132 |
| Allston | 02134 |
| Brighton | 02135 |
| Hyde Park | 02136 |
| Chelsea | 02150 |
| Revere | 02151 |
| Winthrop | 02152 |

Dorchester covers four ZIP areas (02121, 02122, 02124, 02125), so "Dorchester" names none of them. Each answers to the GNIS village it is known by instead; for 02124 that is Dorchester Center, which is also its postal name. Some names are left out:
- Back Bay: its GNIS point lies in 02115, not 02116.
- Beacon Hill: its GNIS point lies 15 m from the border of 02114.
- South End, Fenway, Mission Hill, Chinatown and the Seaport: GNIS has no populated place for them.

#### Denver

| | |
|---|---|
| Dataset | 2020 Census ZCTAs, and the 2020 Census outline of the City and County of Denver, Colorado (GEOID 08031), January 1, 2020 vintage |
| Publisher | U.S. Census Bureau, through its TIGERweb map service |
| URL | as for Boston |
| Licence | Public domain (17 U.S.C. § 105) |
| Retrieved | 2026-10-27 |
| Used in | `packages/geo/src/data/denver.ts`, built with `tools/geo/denver-aliases.json` |

Transformations:

1. Of the 78 ZCTAs that meet the box, 37 lie wholly outside and are left out, and 5 keep less than 1 km² inside (80012, 80110, 80214, 80226 and 80232) and are left out as slivers. 17 are clipped to the county line. The result is 36 ZIP areas.
2. Four downtown ZCTAs under 0.1 km² are merged: 80290, 80293 and 80294 into 80202, and 80264 into 80203. Each host also answers to the merged ZIPs. Glendale, an Arapahoe County city surrounded by Denver, is left as a hole that no area fills. The 32 ZIP areas cover about 400 km², the whole county, including the airport's 80249.
3. As Nashville's step 3, at a 15 m interval: about 105 KB, 3,189 display vertices.
4. to 6. As Nashville's. 80123, 80222 and 80246 store an interior point. Ten ZIP areas that keep under 90% of their area are labelled "Denver part": 80014, 80123, 80212, 80216, 80221, 80222, 80231, 80235, 80246 and 80247.
7. Four ZIP areas answer to an approximate alias:

| Approximate alias | ZIP area |
|---|---|
| Five Points | 80205 |
| University Park | 80210 |
| Bear Valley | 80227 |
| Montbello | 80239 |

80227 keeps 14% of its area, the Bear Valley neighbourhood, and 80239 80%, so their aliases label them instead of "Denver part". GNIS has no populated place for LoDo, RiNo, Capitol Hill, Cherry Creek (a stream in GNIS), the Highlands (GNIS has only a "Highland Park"), Washington Park, Stapleton or Green Valley Ranch, so those names match no area. University Hills, whose GNIS point also lies in 80210, is left out so that 80210 carries one name.

#### Atlanta

| | |
|---|---|
| Dataset | 2020 Census ZCTAs, and the 2020 Census outlines of Fulton County (GEOID 13121) and DeKalb County (GEOID 13089), Georgia, January 1, 2020 vintage |
| Publisher | U.S. Census Bureau, through its TIGERweb map service |
| URL | as for Boston |
| Licence | Public domain (17 U.S.C. § 105) |
| Retrieved | 2026-10-27 |
| Used in | `packages/geo/src/data/atlanta.ts`, built with `tools/geo/atlanta-aliases.json` and `--part-label "Fulton-DeKalb"` |

Transformations:

1. Of the 135 ZCTAs that meet the box around the two counties, 60 lie wholly outside and are left out, and 4 keep less than 1 km² inside (30012, 30092, 30094 and 30214) and are left out as slivers. 20 are clipped to the county lines. The result is 71 ZIP areas. The clip is the two counties' combined outline, so a ZIP that straddles the Fulton and DeKalb line stays whole.
2. ZCTA 30334 (0.064 km², the State Capitol block) is merged into 30303. The 70 ZIP areas cover about 2,085 km², both counties. Hartsfield-Jackson's terminal lies in Clayton County, so a point there locates to no area, although ZCTA 30337 holds it.
3. As Nashville's step 3, at a 15 m interval: about 416 KB, 16,641 display vertices.
4. to 6. As Nashville's. 30087 stores an interior point. Twelve ZIP areas that keep under 90% of their area are labelled "Fulton-DeKalb part": 30005, 30024, 30039, 30087, 30097, 30288, 30294, 30296, 30339, 30340, 30349 and 30360. 30004 keeps 69% and is labelled by its alias, Milton.
7. Twenty-eight ZIP areas answer to an approximate alias. 30306 has two: Virginia-Highland, the neighbourhood's own spelling, and Virginia Highlands, GNIS's.

| Approximate alias | ZIP area |
|---|---|
| Avondale Estates | 30002 |
| Milton | 30004 |
| Alpharetta | 30009 |
| Clarkston | 30021 |
| Johns Creek | 30022 |
| Decatur | 30030 |
| Lithonia | 30058 |
| Roswell | 30075 |
| Stone Mountain | 30083 |
| Tucker | 30084 |
| Fairburn | 30213 |
| Palmetto | 30268 |
| Union City | 30291 |
| Five Points | 30303 |
| Buckhead | 30305 |
| Virginia-Highland, Virginia Highlands | 30306 |
| West End | 30310 |
| Cascade Heights | 30311 |
| Vine City | 30314 |
| East Atlanta | 30316 |
| Kirkwood | 30317 |
| Brookhaven | 30319 |
| Sandy Springs | 30328 |
| College Park | 30337 |
| Dunwoody | 30338 |
| Chamblee | 30341 |
| East Point | 30344 |
| Hapeville | 30354 |

Some names are left out:
- No GNIS populated place: Midtown, Old Fourth Ward, Little Five Points, Cabbagetown, Grant Park and West Midtown.
- GNIS point too close to the ZIP area's border: Inman Park (198 m), Doraville (259 m), South Fulton (291 m) and Stonecrest (279 m).
- Neighbourhoods inside a ZIP area better known by other names: Ansley Park, in Midtown's 30309, and Edgewood, in 30307 with Inman Park and Candler Park.

#### Houston

| | |
|---|---|
| Dataset | 2020 Census ZCTAs, and the 2020 Census outline of Harris County, Texas (GEOID 48201), January 1, 2020 vintage |
| Publisher | U.S. Census Bureau, through its TIGERweb map service |
| URL | as for Boston |
| Licence | Public domain (17 U.S.C. § 105) |
| Retrieved | 2026-10-27 |
| Used in | `packages/geo/src/data/houston.ts`, built with `tools/geo/houston-aliases.json` and `--interval 25` |

Transformations:

1. Of the 178 ZCTAs that meet the box, 35 lie wholly outside and are left out. 22 are clipped to the county line, and none is a sliver. The result is 143 ZIP areas.
2. No ZCTA is under 0.1 km², so none is merged. The 143 ZIP areas cover about 4,603 km², the whole county.
3. As Nashville's step 3, at a 25 m interval instead of 15 m. Harris County has four times Davidson's ZIP areas, and 25 m keeps the module to about 523 KB (18,048 display vertices); 15 m would make it about 667 KB.
4. to 6. As Nashville's. Every area-weighted centroid lies inside its area. Fifteen ZIP areas that keep under 90% of their area are labelled "Harris part": 77053, 77339, 77357, 77365, 77450, 77477, 77484, 77489, 77493, 77494, 77521, 77523, 77535, 77546 and 77581.
7. Thirty-one ZIP areas answer to an approximate alias. 77008 also answers to The Heights, and 77018 to Oak Forest, which GNIS also places inside it.

| Approximate alias | ZIP area |
|---|---|
| West University Place | 77005 |
| Houston Heights, The Heights | 77008 |
| Woodland Heights | 77009 |
| Cloverleaf | 77015 |
| Garden Oaks, Oak Forest | 77018 |
| Eastwood | 77023 |
| Jacinto City | 77029 |
| Westbury | 77035 |
| Jersey Village | 77040 |
| Alief | 77072 |
| Sharpstown | 77074 |
| Meyerland | 77096 |
| Huffman | 77336 |
| Humble | 77338 |
| Atascocita | 77346 |
| Spring | 77373 |
| Tomball | 77375 |
| Klein | 77379 |
| Bellaire | 77401 |
| Hockley | 77447 |
| Baytown | 77520 |
| Channelview | 77530 |
| Crosby | 77532 |
| Deer Park | 77536 |
| Galena Park | 77547 |
| Highlands | 77562 |
| La Porte | 77571 |
| Seabrook | 77586 |
| South Houston | 77587 |
| Webster | 77598 |

Some names are left out:
- No GNIS populated place: Montrose, Midtown, River Oaks, the Third and Fifth Wards, the Galleria and Uptown, and Katy, whose GNIS point lies outside Harris County.
- GNIS point too close to the ZIP area's border: Kingwood (89 m), Pasadena (29 m), Cypress (21 m) and Clear Lake (292 m).
- Mission Bend: GNIS also places it in Fort Bend County.
- The Memorial villages share 77024 and are not used as its label.

#### Dallas

| | |
|---|---|
| Dataset | 2020 Census ZCTAs, and the 2020 Census outline of Dallas County, Texas (GEOID 48113), January 1, 2020 vintage |
| Publisher | U.S. Census Bureau, through its TIGERweb map service |
| URL | as for Boston |
| Licence | Public domain (17 U.S.C. § 105) |
| Retrieved | 2026-10-27 |
| Used in | `packages/geo/src/data/dallas.ts`, built with `tools/geo/dallas-aliases.json` |

Transformations:

1. Of the 103 ZCTAs that meet the box, 8 lie wholly outside and are left out, and 3 keep less than 1 km² inside (75287, 76051 and 76065) and are left out as slivers. 21 are clipped to the county line. The result is 92 ZIP areas.
2. ZCTA 75270 (0.010 km², a downtown block) is merged into 75202. The 91 ZIP areas cover about 2,353 km², the whole county.
3. As Nashville's step 3, at a 15 m interval: about 386 KB, 14,058 display vertices.
4. to 6. As Nashville's. Every area-weighted centroid lies inside its area. Thirteen ZIP areas that keep under 90% of their area are labelled "Dallas part": 75007, 75050, 75051, 75052, 75054, 75067, 75080, 75082, 75089, 75098, 75125, 75154 and 75252.
7. Eighteen ZIP areas answer to an approximate alias, all of them the suburban cities and towns that the ZIP areas are known by, and Highland Park:

| Approximate alias | ZIP area |
|---|---|
| Addison | 75001 |
| Carrollton | 75006 |
| Coppell | 75019 |
| Garland | 75040 |
| Sachse | 75048 |
| Rowlett | 75088 |
| Cedar Hill | 75104 |
| DeSoto | 75115 |
| Duncanville | 75116 |
| Hutchins | 75141 |
| Lancaster | 75146 |
| Mesquite | 75149 |
| Seagoville | 75159 |
| Wilmer | 75172 |
| Balch Springs | 75180 |
| Sunnyvale | 75182 |
| Highland Park | 75205 |
| Farmers Branch | 75234 |

Some names are left out:
- No GNIS populated place: Deep Ellum, Uptown, the Bishop Arts District, Lakewood, Lake Highlands, Preston Hollow and Pleasant Grove.
- GNIS point too close to the ZIP area's border:
  - Oak Cliff (72 m in 75203) and University Park (106 m; its GNIS point lies in 75205, Highland Park's ZIP area);
  - Richardson (282 m), Irving (99 m), Grand Prairie (108 m) and Glenn Heights (155 m), each in a ZIP area of over 5 km².
- Cockrell Hill: a small city inside 75211, which is mostly Dallas, so it is not used as 75211's label.

### Census crosswalk

Area economics reads US Census ACS estimates (see "US Census Bureau Data API" below) for the Census units each neighbourhood is made of. Which units those are comes from two polygon-free tables built by `tools/geo/tracts.ts`, plus the ZIP areas' own ids. None of these tables hold any ACS figures.

| | |
|---|---|
| Dataset | 2020 Census Gazetteer Files: census tracts (`2020_Gaz_tracts_national`), with each tract's GEOID, land area and interior point (`INTPTLAT`, `INTPTLONG`). 2020 ZCTA to county relationship file (`tab20_zcta520_county20_natl`), with the land area of each ZCTA and of its part in each county. |
| Publisher | U.S. Census Bureau, Geography Division |
| URL | <https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_tracts_national.zip> and <https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt> |
| Licence | Public domain. Census Bureau geography is a work of the U.S. Government, which is not subject to copyright in the United States (17 U.S.C. § 105). |
| Retrieved | 2026-10-27 |
| Used in | `packages/geo/src/data/tracts-nyc.ts` and `tracts-austin.ts`, built by `tools/geo/tracts.ts --metro <nyc\|austin> --gazetteer <file>`; `packages/geo/src/data/zcta-clip.ts`, built by `tools/geo/tracts.ts --zcta-clip --relation <file>` |

Method:

1. ZIP-area cities (Nashville and the ten cities above). An area's units are the ZCTA in its id, plus every ZCTA merged into it, which it answers to as "ZIP <code>". ACS reports whole ZCTAs, so an area clipped to its city's counties gets figures for the whole ZIP. Such an area is marked as clipped when its name carries a "(… part)" label, or when less than 90% of its ZCTAs' land lies inside the counties. The second test is needed because a clipped area named after a place, such as "ZIP 80227 (Bear Valley)", has no part label. The land shares come from the relationship file, for the counties each city section above names. Only areas with less than 99% of their land inside are listed, as whole percents.
2. New York and Austin. Their areas are not ZIP areas, so their units are 2020 census tracts. Each tract with land is assigned whole to the area whose shipped outline holds its interior point. A tract whose point lies in no area is left out, for example one in a park, an airport or a cemetery that New York's community districts leave out, or one outside Austin's planning areas. Water-only tracts are left out too. In New York, 2,246 tracts are assigned to the 59 districts. In Austin, 118 tracts are assigned to 61 of the 65 planning areas.
3. Four Austin planning areas are smaller than the tracts around them and hold no tract's interior point: East Cesar Chavez, North Loop, Southeast and West Congress. For each, the tract whose interior point lies nearest the area's centre stands in, within 2 km. Its figures describe more than the area, and the data marks it as a stand-in.
4. A tract that crosses an area's border counts entirely for the area that holds its interior point. Area figures are therefore approximate at the edges, and more so for small areas made of one or two tracts.

## SEC EDGAR

Company financials (revenue, gross profit and operating income) are read at runtime from the U.S. Securities and Exchange Commission's EDGAR system.

| | |
|---|---|
| Dataset | XBRL company facts (`https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`), and the ticker to CIK map (`https://www.sec.gov/files/company_tickers.json`) |
| Publisher | U.S. Securities and Exchange Commission |
| URL | <https://www.sec.gov/search-filings/edgar-application-programming-interfaces> |
| Licence | Public information. The SEC's website policies state that information presented on sec.gov is public information and may be copied or further distributed without the SEC's permission. Filings are the filers' own reported figures. |
| Access | The SEC's fair access policy: every request declares a User-Agent with the product name and a contact address, and requests stay under the SEC's limit of 10 per second (this app allows 5). |
| Used in | `packages/publicdata` (the client), and the company financials tool. The brand to ticker map, `config/listed_companies.json`, holds names and tickers only. |

**No SEC figures are stored in this repository.** Responses are cached privately in the application's database for up to 7 days, and test fixtures use invented companies and values. Every figure is shown as reported, with its fiscal period, form and filing date, and its evidence names the filing's accession number. Figures are company-wide: where a brand is part of a larger company, the answer says so. They are reported figures, not investment advice.

## US Census Bureau Data API

This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.

| | |
|---|---|
| Dataset | American Community Survey (ACS) 5-year estimates, by ZIP Code Tabulation Area and by census tract |
| Publisher | U.S. Census Bureau |
| URL | <https://api.census.gov/data.html> (`https://api.census.gov/data/<vintage>/acs/acs5`) |
| Licence | Public domain (17 U.S.C. § 105). Use of the API is subject to the Census Bureau's [API terms of service](https://www.census.gov/data/developers/about/terms-of-service.html), which ask for the notice above. |
| Used in | `packages/publicdata` (the client), the area economics tool, and the census crosswalk above |

Only a fixed set of fields is requested: total population, median age, households, median household income, and how workers commute (drove alone, public transit, walked, bicycle, worked from home). No race, ethnicity, religion or other sensitive variables are ever requested. Each vintage is cached privately in the application's database. **No Census estimates are stored in this repository**, and test fixtures use invented areas and values.

ACS figures are estimates from a survey, with margins of error. They describe residents, not visitors or workers who live elsewhere. An area's figures are rolled up from its ZCTAs or tracts (see "Census crosswalk"): counts are summed, and medians are a population-weighted average of the units' medians, which is an approximation. Every answer names the ACS vintage it used.

## OpenStreetMap (Overpass API)

Map data from OpenStreetMap, © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0, via the Overpass API.

| | |
|---|---|
| Dataset | OpenStreetMap: counts and names of places by tag (cafés, bars, shops and the other place types in `config/osm_tags.json`), inside a neighbourhood outline, around a market's centre, or inside a map city's counties |
| Publisher | OpenStreetMap contributors, through the OpenStreetMap Foundation; read with the Overpass API (`https://overpass-api.de/api/interpreter` by default, or the instance `OSM_OVERPASS_URL` names) |
| URL | <https://www.openstreetmap.org/copyright> and <https://wiki.openstreetmap.org/wiki/Overpass_API> |
| Licence | [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Every figure, table and map layer built from it shows "© OpenStreetMap contributors" with a link to <https://www.openstreetmap.org/copyright>. |
| Access | The Overpass usage policy: every request declares a User-Agent naming the product and a contact (`OSM_USER_AGENT`), one request at a time and at least a second apart, a daily cap for the whole deploy (`OSM_DAILY_MAX`, default 2,000, well under the policy's 10,000), and a 30-day cache. |
| Used in | `packages/publicdata` (the client), and the local supply tool |

`config/osm_tags.json` holds tag names only (such as `amenity=cafe`), with the date and taginfo usage count that admitted each one (taginfo statistics, <https://taginfo.openstreetmap.org>), and, per map city, the Wikidata ids of its counties (Wikidata is CC0) and each county's land area from the U.S. Census Bureau 2020 Gazetteer counties file (`2020_Gaz_counties_national`, ALAND, public domain, 17 U.S.C. § 105). **No OpenStreetMap counts or places are stored in this repository**: responses are cached privately in the application's database, and test fixtures use invented places and counts.

OpenStreetMap is mapped by volunteers. A count is a floor, not a census: a place nobody has mapped is not counted, and how completely an area is mapped varies. Every answer says so, and names the date of the data it read.

## Qloo

Taste data comes from the [Qloo](https://qloo.com) API at runtime. **No Qloo data is stored in this repository**: no responses, scores, entity IDs or request IDs. Responses are cached privately in the application's database, and `pnpm guard` and gitleaks check every commit for leaks.
