# Attribution

Culture Terminal is released under the MIT License (see `LICENSE`). It uses the third-party work below, each under its own licence.

## Fonts

All fonts are self-hosted through [Fontsource](https://fontsource.org) packages.

| Font | Licence | Package |
|---|---|---|
| IBM Plex Mono | SIL Open Font License 1.1 | `@fontsource/ibm-plex-mono` |
| IBM Plex Sans | SIL Open Font License 1.1 | `@fontsource/ibm-plex-sans` |
| IBM Plex Sans Condensed | SIL Open Font License 1.1 | `@fontsource/ibm-plex-sans-condensed` |
| Inter | SIL Open Font License 1.1 | `@fontsource-variable/inter` |
| Instrument Serif | SIL Open Font License 1.1 | `@fontsource/instrument-serif` |
| Source Serif 4 | SIL Open Font License 1.1 (Reserved Font Name "Source") | `@fontsource-variable/source-serif-4` |

IBM Plex is a trademark of IBM Corp. The OFL text is at <https://openfontlicense.org>.

The share cards (`apps/web/lib/og/fonts`) carry static instances of Inter and Source Serif 4, cut to the card's characters and renamed "CT Card Sans" and "CT Card Serif", as the OFL asks of a Modified Version, each with its licence under its own copyright notice beside it. `build-fonts.mjs` in that folder rebuilds them from the packages above.

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

## Qloo

Taste data comes from the [Qloo](https://qloo.com) API at runtime. **No Qloo data is stored in this repository**: no responses, scores, entity IDs or request IDs. Responses are cached privately in the application's database, and `pnpm guard` and gitleaks check every commit for leaks.
