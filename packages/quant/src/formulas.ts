/**
 * The FORMULAS registry (SPEC §5.2): one entry per computed quantity. /method and every tooltip
 * render from it, and every Metric.formulaId and Dataset.formulaIds must be one of these ids.
 *
 * Seam file: the id list is fixed for the parallel build; the quant-core workstream fills FORMULAS.
 */

export const FORMULA_IDS = [
  // Shared primitives (D14)
  "pct.within_call",
  "quality_gate",
  "popularity",
  // S0 resolution
  "resolve.exact_match",
  // S1 Substitution Map
  "subs.similarity",
  "subs.rank_in_row",
  "subs.hub",
  "subs.distinctiveness",
  "subs.near_substitutes",
  "subs.taste_island",
  // S2 Share-of-Taste
  "share.pct",
  "share.youth_tilt",
  "share.metros_won",
  "share.pair_split",
  // S3 Audience DNA
  "dna.age_index",
  "dna.gender_index",
  "dna.youth_index",
  "dna.distinctive_tags",
  // S4 Momentum
  "mom.delta_26w",
  "mom.mann_kendall",
  "mom.label",
  "mom.freshness",
  // S5 Travel taste
  "trvl.quadrant",
  "trvl.hidden_pocket",
  // S6 Lift and white space
  "lift.cell",
  "lift.area",
  "lift.confidence",
  "lift.white_space",
  "lift.area_popularity",
  // S7 Block DNA and S8 Tenant fit
  "block.rank_delta",
  "block.new_tag",
  "block.panel_rank",
  "block.concept_rank",
  "tenant.rank_shift",
  "tenant.fit",
  "rank.shift",
  // S9 Cultural neighbourhood and S10 Sponsor Slate
  "xdom.under_the_radar",
  "xdom.edge",
  "xdom.partners_one_category",
  "slate.best_fit",
  "slate.under_the_radar",
  "slate.market_alignment",
  // S11 Taste Twins
  "twin.rho",
  "twin.shared_new",
  // S12 Concept Vector
  "cnpt.s50",
  "cnpt.verdict",
  "cnpt.precision",
  // S13 Company financials (SEC EDGAR)
  "fin.revenue",
  "fin.margin",
  "fin.yoy",
  // S14 Area economics (US Census ACS)
  "econ.count",
  "econ.median",
  "econ.share",
  // S15 Local supply (OpenStreetMap, Part 11)
  "osm.count",
  "osm.density",
  "osm.density_index",
  "osm.activity_density",
  // Brand screener and Category Taste Map (Part 10)
  "screen.universe",
  "screen.under_the_radar",
  "taste_map_mds",
  // Report-level (§6.4)
  "confidence.run",
  "confidence.metric",
] as const;

export type FormulaId = (typeof FORMULA_IDS)[number];

export interface Formula {
  id: FormulaId;
  name: string;
  /** TeX source for /method; no decimals with 3 or more fractional digits (pnpm guard). */
  formula_tex: string;
  plain_english: string;
  caveats: string[];
}

// Caveats shared by several entries, so the same limit always reads the same way.
const NOT_SALES = "Affinity is a taste signal, not sales, share or causation.";
const WITHIN_CALL = "Percentiles compare candidates inside one Qloo call only; never compare them across calls.";
const UNSCORED = "Candidates a call did not score, or that sit at its shared floor value, are shown as not scored, never as last.";
const GROUP_LEVEL = "Aggregated group-level taste signals; no individual-level inference.";
const PEER_SET = "Relative to the chosen peer set; different peers give different results.";
const INDICES = "Relative affinity indices from −1 to 1, not population shares.";
const HISTORICAL = "Historical window only (Qloo trending over one fixed past window), always badged STALE with the window.";
const METRO = "Metro context is a Qloo locality taste signal, not residence, attendance or sales.";
const NO_PRICE = "Not about price or value: Qloo has no pricing data.";
const VENUE_GOERS = "Taste signals of venue-goers, not residents or census data.";
const REPORTED = "As reported in the company's SEC filings (XBRL company facts), in US dollars; not advice.";
const COMPANY_WIDE = "Company-level: a brand inside a larger company is not broken out.";
const ACS = "US Census ACS 5-year survey estimates for residents, with sampling error; not customers, visitors or spending.";
const OSM_FLOOR = "OpenStreetMap is mapped by volunteers: counts are a floor, not a census.";
const OSM_NOT_DEMAND = "A count of mapped places, not sales, rents, foot traffic or how busy the places are.";
const OSM_CITY = "The city reference is the county or counties around the city (approximate), so an index compares an area with that whole area.";

type FormulaBody = Omit<Formula, "id">;

const BODIES: Readonly<Record<FormulaId, FormulaBody>> = {
  "pct.within_call": {
    name: "Within-call percentile (FIT)",
    formula_tex: String.raw`\mathrm{pct}_i = 1 - \frac{r_i - 1}{n - 1}, \quad r_i = \text{descending average rank of } i \text{ among the } n \text{ scored candidates}`,
    plain_english:
      "Where a candidate sits among the others scored in the same Qloo call: 1 is the top of the call, 0 the bottom. Ties share an averaged rank, and a lone scored candidate gets 1. Candidates at the call's shared floor value have no relationship to the signal, so they are left unscored rather than ranked last.",
    caveats: [WITHIN_CALL, UNSCORED, NOT_SALES, "A percentile of a small set moves in large steps; read it with the set size (k of n)."],
  },
  quality_gate: {
    name: "Quality gate",
    formula_tex: String.raw`\text{keep } j \iff p_j \ge 0.01`,
    plain_english:
      "Results with a Qloo popularity below 0.01 are treated as likely artifacts and dropped before any statistic is computed. Every drop is recorded in the ledger and lowers the run's confidence.",
    caveats: [
      "A dropped result can be a real but very obscure entity.",
      "Results without a popularity value are kept, since a missing field is not evidence of an artifact.",
    ],
  },
  popularity: {
    name: "Popularity (reach)",
    formula_tex: String.raw`p_j \in [0, 1]`,
    plain_english:
      "Qloo's 0 to 1 popularity score for the entity: how widely it registers across Qloo's data relative to other entities. It is the Reach axis of the Taste Position card and the baseline that UNDER-THE-RADAR subtracts.",
    caveats: [
      "Breadth of cultural signal, not revenue, sales or market share.",
      "Small differences between entities are not meaningful; read it as a rank among peers.",
    ],
  },
  "resolve.exact_match": {
    name: "Exact-match resolution",
    formula_tex: String.raw`\mathrm{match}(m, e) \iff \mathrm{norm}(m) = \mathrm{norm}(\mathrm{name}_e) \ \wedge\ \mathrm{type}_e = t_m`,
    plain_english:
      "A mention resolves to a Qloo entity only when the two names are equal after normalising (accents folded, lower case, punctuation removed, spaces collapsed, a leading The and trailing corporate suffixes such as Inc, Co, Company, LLC and Ltd removed) and the entity type matches. Nothing is ever substituted: a main subject without an exact match goes to a picker, and a secondary mention without one is dropped with a limitation.",
    caveats: [
      "Popularity never decides a match.",
      "An entity missing from Qloo's hackathon dataset cannot be analysed.",
      "Two exact matches with the same name need a human pick.",
    ],
  },
  "subs.similarity": {
    name: "Pairwise taste similarity",
    formula_tex: String.raw`\mathrm{sim}_{ij} = \mathrm{affinity}(j \mid \text{signal} = i) = \mathrm{sim}_{ji}`,
    plain_english:
      "Qloo's affinity for entity j when entity i is the taste signal. The gating probe verified that this score is symmetric and does not depend on which other candidates share the call, so one triangular set of calls fills the whole grid.",
    caveats: [
      "Audience taste similarity, not switching, share or sales.",
      "Single-seed scores, and the scores are compressed: read ranks rather than raw values.",
      "Pairs Qloo did not score are shown as not measured.",
      "Symmetric by construction, so no claim that one brand takes customers from another.",
    ],
  },
  "subs.rank_in_row": {
    name: "Rank in row",
    formula_tex: String.raw`rr_{ij} = 1 + \#\{ k \ne i : \mathrm{sim}_{ik} \text{ scored},\ \mathrm{sim}_{ik} > \mathrm{sim}_{ij} \} \quad (1 = \text{most similar; tied cells share the best rank})`,
    plain_english:
      "In each entity's row of the grid, its peers are ranked from most to least similar; the glyph in each cell shows this rank. Tied peers share the best rank among them (1, 2, 2, 4), so the glyph is always a whole number.",
    caveats: [
      "A rank inside one row; rows can differ in how many peers were scored.",
      "A tie skips the ranks its members would have taken, so the largest glyph in a row can be below the number of scored peers.",
      "Hub and near-substitutes read averaged ranks instead: two peers tied for first both show 1 here, yet neither is the row's single closest peer.",
      "The similarity behind it is symmetric, so a rank is not a claim about direction.",
    ],
  },
  "subs.hub": {
    name: "Hub score",
    formula_tex: String.raw`\mathrm{Hub}_j = \frac{1}{|R_j|} \sum_{i \in R_j} \mathrm{pct}_{ij}, \quad \mathrm{pct}_{ij} = 1 - \frac{\bar{r}_{ij} - 1}{n_i - 1}, \quad \bar{r}_{ij} = \text{average rank of } \mathrm{sim}_{ij} \text{ among the } n_i \text{ scored cells of row } i, \quad R_j = \{ i \ne j : \mathrm{sim}_{ij} \text{ scored} \}, \quad \text{measured only when } |R_j| \ge \max\big(2, \lceil (k - 1)/2 \rceil\big)`,
    plain_english:
      "How central an entity is in the peer set: the average of its within-row percentiles across the other entities' rows. A hub sits close to many peers; a niche entity sits at the edge of the set.",
    caveats: [
      PEER_SET,
      "Centrality in taste, not size, share or sales.",
      "Not measured for an entity scored in fewer than half of the other rows (or fewer than 2): a score read off one row would make a brand close to a single peer look central.",
    ],
  },
  "subs.distinctiveness": {
    name: "Distinctiveness",
    formula_tex: String.raw`D_i = 1 - \max_{j \ne i} \mathrm{sim}_{ij}`,
    plain_english:
      "How far an entity's audience taste is from its nearest peer: one minus its highest similarity to any other entity in the set. It is shown as a peer rank (k of n), where 1 is the most distinctive.",
    caveats: [
      PEER_SET,
      "Two entities that are each other's nearest peer share the same value and the same rank.",
      "Distinctive taste is evidence about substitution risk, not proof of a durable advantage.",
    ],
  },
  "subs.near_substitutes": {
    name: "Near-substitutes",
    formula_tex: String.raw`\bar{r}_{ij} = \bar{r}_{ji} = 1 \ \wedge\ \mathrm{sim}_{ij} \ge Q_{0.9}\big(\{ \mathrm{sim}_{kl} : k < l \text{ scored} \}\big)`,
    plain_english:
      "Two entities are near-substitutes when each is the other's single most similar peer (average rank 1, so a tie for first does not count) and their similarity is in the top tenth of all scored pairs in the set.",
    caveats: [
      "Shared audience taste, not evidence that customers switch between them.",
      "The threshold is relative to the set, so in a small set the closest pair usually qualifies.",
      "No direction: neither entity is said to take from the other.",
    ],
  },
  "subs.taste_island": {
    name: "Taste island",
    formula_tex: String.raw`\frac{\#\{ i \ne t : t \text{ ranks last in row } i \}}{\#\{ i \ne t : t \text{ is scored in row } i \}} \ge 0.75, \quad \text{with at least 3 scored rows}`,
    plain_english:
      "The target is a taste island when it ranks last in at least three quarters of the peer rows where it is scored, and it is scored in at least 3 rows: its audience's taste sits apart from the whole peer set.",
    caveats: [
      PEER_SET,
      "Taste set apart is not weak demand or poor performance.",
      "Rows where the target was not scored do not count, and a row with no ordering (only the target scored, or every cell tied) has no last place.",
    ],
  },
  "share.pct": {
    name: "Share-of-Taste percentile",
    formula_tex: String.raw`\mathrm{pct}_{cj} = 1 - \frac{r_{cj} - 1}{n_c - 1}, \quad r_{cj} = \text{rank of } j \text{ among the } n_c \text{ entities scored in context } c`,
    plain_english:
      "In each context (an age group, an audience or a metro), the same set of entities is ranked by Qloo's affinity for that context. The grid shows each entity's within-call percentile and its rank k of n.",
    caveats: ["Within-call rank among this set only; not market share.", METRO, UNSCORED],
  },
  "share.youth_tilt": {
    name: "Youth tilt",
    formula_tex: String.raw`\mathrm{Tilt}_j = \frac{1}{|Y|} \sum_{b \in Y} \mathrm{pct}_{j,b} - \frac{1}{|O|} \sum_{b \in O} \mathrm{pct}_{j,b}, \quad Y \subseteq \{ \le 24,\ 25\text{–}29 \},\ O \subseteq \{ 45\text{–}54,\ 55+ \} \text{ queried, pct among the entities all of them ranked}`,
    plain_english:
      "The entity's average percentile in the young age contexts queried (24 and younger, 25–29) minus its average in the old ones queried (45–54, 55 and older); it needs at least one of each. Those calls are re-ranked over the entities all of them scored, so every tilt subtracts percentiles of the same set. With all four buckets fully scored it is the two youngest minus the two oldest. Positive means the set ranks it higher for younger audiences than for older ones.",
    caveats: [
      "Relative to this set of entities, not the age mix of customers.",
      WITHIN_CALL,
      GROUP_LEVEL,
      "An entity one of those calls did not score has no tilt, never 0.",
    ],
  },
  "share.metros_won": {
    name: "Metros won",
    formula_tex: String.raw`W_j = \#\{ m : r_{mj} = 1 \}, \quad H_j = \#\{ m : \mathrm{pct}_{mj} \ge 0.5 \}`,
    plain_english:
      "The number of metros where the entity ranks first in the set, together with how many metros place it in the top half (top-half in K of M).",
    caveats: [
      METRO,
      "Only the metros queried in this run that ranked the set count.",
      WITHIN_CALL,
      "An entity no metro ranked has no count, never 0; one ranked in only some metros shows how many ranked it.",
    ],
  },
  "share.pair_split": {
    name: "Pair split (who wins where)",
    formula_tex: String.raw`s_c = \frac{a_{c,1}}{a_{c,1} + a_{c,2}}, \quad 1 - s_c \text{ for the second entity}`,
    plain_english:
      "For a pair, in each context: the first entity's share of the two entities' affinities from that one Qloo call; the second entity has the rest, so the two sum to 1. A share within 0.02 of an even split reads as even.",
    caveats: [WITHIN_CALL, METRO, "A share of two affinities in one call, not market share or sales."],
  },
  "dna.age_index": {
    name: "Age affinity index",
    formula_tex: String.raw`a_b \in [-1, 1], \quad b \in \{ \le 24,\ 25\text{–}29,\ 30\text{–}34,\ 35\text{–}44,\ 45\text{–}54,\ 55+ \}`,
    plain_english:
      "Qloo's relative affinity of each age group for the entity, from −1 (well below average) through 0 (average) to 1 (well above average).",
    caveats: [INDICES, GROUP_LEVEL, "An entity without a demographics block is shown as not measured."],
  },
  "dna.gender_index": {
    name: "Gender affinity index",
    formula_tex: String.raw`g_s \in [-1, 1], \quad s \in \{ \text{male}, \text{female} \}`,
    plain_english: "Qloo's relative affinity of each gender group for the entity, on the same −1 to 1 scale as the age index.",
    caveats: [INDICES, "Gender is binary in the source data.", GROUP_LEVEL],
  },
  "dna.youth_index": {
    name: "Youth index (Y)",
    formula_tex: String.raw`Y = \tfrac{1}{2}\big(a_{\le 24} + a_{25\text{–}29}\big) - \tfrac{1}{2}\big(a_{45\text{–}54} + a_{55+}\big)`,
    plain_english:
      "The average age index of the two youngest groups minus that of the two oldest. Positive means the entity's audience taste leans younger.",
    caveats: [INDICES, GROUP_LEVEL],
  },
  "dna.distinctive_tags": {
    name: "Distinctive tags",
    formula_tex: String.raw`\{ \tau \in T_t : \#\{ p \in P : \tau \in T_p \} < |P| / 2 \}`,
    plain_english:
      "Search tags that the target carries and fewer than half of its peers of the same entity type carry, grouped by namespace: aesthetic, emotional tone, lifestyle, customer segment, personal style, product and genre. Tags in other namespaces are listed as context, never as distinctive.",
    caveats: [
      "Tags describe Qloo's catalogue profile of the entity, not measured customer attributes.",
      "A missing tag is not evidence that the trait is absent.",
      PEER_SET,
      "Compared only with set peers of the same entity type that carry tags; with none, no tag is called distinctive.",
    ],
  },
  "mom.delta_26w": {
    name: "26-week momentum",
    formula_tex: String.raw`\Delta\mathrm{pct}_{26w} = 26 \cdot \operatorname{median}_{i < j} \frac{y_j - y_i}{t_j - t_i}, \quad y = \text{ISO-week median trending percentile}, \ t \text{ in weeks}`,
    plain_english:
      "The robust trend of the entity's Qloo trending percentile: the median of all pairwise slopes between weekly values (Theil–Sen), scaled to 26 weeks. A single outlier week cannot swing it.",
    caveats: [
      HISTORICAL,
      "The trending percentile reflects Qloo signal, not sales.",
      "No signal is not the same as flat: short or nearly constant series show NO SIGNAL.",
    ],
  },
  "mom.mann_kendall": {
    name: "Mann–Kendall trend test",
    formula_tex: String.raw`S = \sum_{i < j} \operatorname{sgn}(y_j - y_i), \quad \tau = \frac{S}{n(n-1)/2}, \quad \mathrm{Var}(S) = \frac{n(n-1)(2n+5) - \sum_g t_g(t_g-1)(2t_g+5)}{18}, \quad z = \frac{S - \operatorname{sgn}(S)}{\sqrt{\mathrm{Var}(S)}}, \quad p = 2\,\big(1 - \Phi(|z|)\big)`,
    plain_english:
      "Tests whether the weekly series moves consistently in one direction. τ runs from −1 (always falling) to 1 (always rising); p is the chance of a pattern at least this consistent in a series with no trend.",
    caveats: [
      HISTORICAL,
      "Step-shaped series repeat values; the variance is corrected for these ties.",
      "A small p shows consistency, not size; read it together with the 26-week momentum.",
    ],
  },
  "mom.label": {
    name: "Momentum label",
    formula_tex: String.raw`\text{Rising if } \Delta \ge 0.02 \wedge p < 0.1; \quad \text{Declining if } \Delta \le -0.02 \wedge p < 0.1; \quad \text{otherwise Flat}`,
    plain_english:
      "Rising needs a 26-week gain of at least 0.02 in trending percentile and a consistent direction (Mann–Kendall p below 0.1); Declining is the mirror image; anything else is Flat.",
    caveats: [
      HISTORICAL,
      "Fewer than 8 points, or a series with almost no distinct values, gives NO SIGNAL rather than Flat.",
    ],
  },
  "mom.freshness": {
    name: "Freshness",
    formula_tex: String.raw`F = \exp\!\big(-m / 12\big), \quad m = \text{months since the trending window ended}`,
    plain_english:
      "How recent the trending window is: 1 at the end of the window, falling to about 0.37 after twelve months.",
    caveats: ["Describes the age of the data, not the strength of the trend."],
  },
  "trvl.quadrant": {
    name: "Travel taste quadrant",
    formula_tex: String.raw`A_d = \mathrm{pct}(\mathrm{affinity}_d), \quad \text{HEARTLAND: } A_d \ge \tilde{A},\ p_d \ge \tilde{p}; \ \text{HIDDEN POCKET: } A_d \ge \tilde{A},\ p_d < \tilde{p}; \ \text{MASS: } A_d < \tilde{A},\ p_d \ge \tilde{p}; \ \text{COLD otherwise}`,
    plain_english:
      "Each destination is placed by how strongly this audience's taste points to it (its percentile in the call) and by its popularity, split at the medians of the result set: HEARTLAND (high fit, high popularity), HIDDEN POCKET (high fit, low popularity), MASS (low fit, high popularity) and COLD. A destination with popularity 0.85 or more is never a hidden pocket, however the set's median falls: with high fit it is HEARTLAND.",
    caveats: [
      "Places this audience's taste points to (travel and leisure), not residence, sales or ticket demand.",
      "Among Qloo's top 50 US destinations for this audience only.",
      "Median splits put half of the set on each side by construction.",
    ],
  },
  "trvl.hidden_pocket": {
    name: "Hidden-pocket score",
    formula_tex: String.raw`H_d = \Phi^{-1}(3/4) \cdot \frac{e_d - \operatorname{median}(e)}{\mathrm{MAD}(e)}, \quad e_d = A_d - (\alpha + \beta\, p_d), \quad (\alpha, \beta) = \text{Theil–Sen fit of } A \text{ on } p`,
    plain_english:
      "How much more this audience's taste points to a destination than its popularity predicts: the robust z-score of its residual from a Theil–Sen line of fit on popularity. Above zero means more taste than popularity explains. A destination is called a hidden pocket when this score is 2 or more and its popularity is below both the set's median and 0.85.",
    caveats: [
      "Relative within this result set.",
      "Travel and leisure taste, not residence or ticket demand.",
      "When more than half the residuals are equal the MAD is zero, and the mean absolute deviation stands in as the spread.",
    ],
  },
  "lift.cell": {
    name: "Cell lift",
    formula_tex: String.raw`L_c = \frac{u_c + 0.05}{v_c + 0.05}, \quad \text{for cells with } u_c \ge 0.5`,
    plain_english:
      "For each map cell, the concept's heat compared with the baseline's heat (restaurants): u and v are the cell's percentiles among the non-zero cells both maps cover. The 0.05 cushion stops cold baseline cells from producing huge ratios, and only cells in the top half of the concept map are scored.",
    caveats: [
      "Relative within the metro.",
      "Lift against the named baseline, not absolute demand.",
      "Both maps are re-keyed to their coarsest shared geohash precision, and zero-affinity cells are excluded.",
      "A cell only one map covers has no lift: not measured, never 0.",
    ],
  },
  "lift.area": {
    name: "Neighbourhood lift",
    formula_tex: String.raw`\mathrm{Lift}_N = \exp\!\Big( \frac{1}{n_N} \sum_{c \in N} \ln L_c \Big), \quad n_N \ge 5 \text{ gated cells}`,
    plain_english:
      "The typical cell lift inside a neighbourhood: the geometric mean of its gated cell lifts, so one extreme cell cannot dominate. A neighbourhood needs at least 5 gated cells to get a value.",
    caveats: [
      "Relative within the metro and against the named baseline.",
      "Neighbourhood boundaries come from our gazetteer; the source is credited on the map.",
      "Maps at geohash 4 or coarser support no neighbourhood claims.",
    ],
  },
  "lift.confidence": {
    name: "Lift confidence",
    formula_tex: String.raw`\mathrm{Conf}_N = \min\!\big(1, n_N / 12\big) \cdot \mathrm{prec}, \quad \mathrm{prec} = 1 \ (\text{gh7}),\ 0.8 \ (\text{gh6}),\ 0.5 \ (\text{gh5}),\ 0 \ (\text{gh4 or coarser})`,
    plain_english:
      "How much weight a neighbourhood lift can bear: it grows with the number of gated cells, reaching full weight at 12, and is scaled down for coarser map precision.",
    caveats: ["Reflects cell count and map precision only, not whether the baseline is the right comparison."],
  },
  "lift.white_space": {
    name: "White space",
    formula_tex: String.raw`\mathrm{WS}_N = \mathrm{Demand\_pct}_N \cdot \big(1 - \mathrm{Supply\_pct}_N\big)`,
    plain_english:
      "High where the concept's taste lift is strong and the density of indexed venues is low. Demand_pct is the neighbourhood's lift percentile and Supply_pct its percentile of venues per square kilometre, both among the neighbourhoods with a lift and only when there are at least three of them. Neighbourhoods tied on density share the lowest percentile of the tie, so one with no sampled venue has Supply_pct 0 and never counts as high supply. Median splits give four groups: high demand with few rivals, high demand with many rivals, low demand with many rivals, and low demand with few rivals.",
    caveats: [
      "Supply is a capped sample of venues Qloo indexes, not a full count of businesses.",
      "Relative within the metro; not rent, footfall or sales.",
      "Without a supply sample (none asked for, no category tag, or a first page that did not come back) white space is not measured, never 0.",
      "A quadrant needs enough venues: at least 10 counted in at least three compared areas, never an area with none in a capped sample, and at least 3 in the area for either group with many rivals. Otherwise the area reads Not enough venue data.",
    ],
  },
  "lift.area_popularity": {
    name: "Where it is already popular",
    formula_tex: String.raw`\mathrm{raw}_N = \frac{1}{n_N} \sum_{c \in N} u_c, \quad \mathrm{rawPct}_N = \text{percentile of } \mathrm{raw}_N \text{ among the areas with one}`,
    plain_english:
      "How strong the concept's own heat is in a neighbourhood, before comparing with the baseline: the mean of its cells' concept percentiles u, then ranked among the areas (needs at least three). An area is popular when it is in the top quarter here; a hidden pocket is in the top quarter for lift but the bottom half here, so it stands out for its size rather than being where the crowd already is. Both stand on the map side by side.",
    caveats: [
      "Relative within the metro and within one call.",
      "Popular means the concept's taste signal is strong there, not sales, footfall or rents.",
      "A hidden pocket is never called the best area on its own: popular areas are shown next to it.",
    ],
  },
  "block.rank_delta": {
    name: "Block rank delta",
    formula_tex: String.raw`\Delta_t = \mathrm{rank}_{\text{city}}(t) - \mathrm{rank}_{\text{area}}(t), \quad \text{a missing rank counts as } N+1`,
    plain_english:
      "How much higher a tag (or a brand) ranks in the area than in the city as a whole. Positive means the area over-indexes on it. A tag missing from a top-50 list counts as rank 51 and a brand missing from a top-30 list as rank 31; a row tied at its list's floor value has no rank and counts as missing.",
    caveats: [
      "Affinities are compressed, so only rank deltas against the city are shown.",
      "Taste signals of venue-goers, not residents or census data.",
      "The area is the one Qloo resolves for the location, not our exact polygon.",
    ],
  },
  "block.new_tag": {
    name: "NEW tag",
    formula_tex: String.raw`t \text{ is NEW} \iff t \notin \mathrm{Top50}_{\text{city}} \ \wedge\ t \in \mathrm{Top20}_{\text{area}}`,
    plain_english:
      "A tag is NEW when it is absent from the city's top 50 yet present in the area's top 20. A tag the city list holds, even unranked at its floor, is not NEW.",
    caveats: ["Taste signals of venue-goers, not residents or census data.", "Commercial concept fit only."],
  },
  "block.panel_rank": {
    name: "Map-city panel rank (city fingerprint)",
    formula_tex: String.raw`\bar r(t) = \frac{1}{|P|} \sum_{c \in P} \mathrm{rank}_c(t), \quad \mathrm{rank}_{\text{panel}}(t) = \text{position of } t \text{ by } \bar r(t) \text{, top 50 only}`,
    plain_english:
      "The comparison a whole city is read against: the other map cities' top-50 tag lists, each tag placed by its average rank across them (a tag missing from a city's list counts as 51 there). Only the panel's top 50 get a rank, like any single list. A city's rank gain on a tag is the panel rank minus the city's own rank, so a positive gain means the city over-indexes on it compared with the other map cities. NEW means absent from every other map city's list.",
    caveats: [
      "The panel is the map cities Culture Terminal covers, not every US city.",
      VENUE_GOERS,
      "Read ranks, not raw scores: affinities are compressed.",
    ],
  },
  "block.concept_rank": {
    name: "Concept tag rank (Block DNA)",
    formula_tex: String.raw`\text{area: } \Delta_t = \mathrm{rank}_{\text{city}}(t) - \mathrm{rank}_{\text{area}}(t); \quad \text{city: } \mathrm{place}_c(t) = 1 + \big|\{c' \in P : \mathrm{rank}_{c'}(t) < \mathrm{rank}_c(t)\}\big|, \quad \text{a missing rank counts as } 51`,
    plain_english:
      "How the question's concept tags stand in a Block DNA read, at no extra call. For a neighbourhood or point: how many places higher each concept tag ranks in the area's top-50 tag list than in the city's, as the rank gain does. For a whole city: its place among itself and the other map cities when each city is ordered by the tag's rank in its own top-50 list (1 = the city where the tag ranks highest; a city whose list misses the tag counts it as 51, and cities on the same rank share a place). A tag outside the tag families Block DNA reads, or in none of the lists, gets no value and says why.",
    caveats: [
      "The panel is the map cities Culture Terminal covers, not every US city.",
      VENUE_GOERS,
      "A place among cities orders ranks; it does not say by how much one city leads another.",
    ],
  },
  "tenant.rank_shift": {
    name: "Rank shift (site vs city)",
    formula_tex: String.raw`\Delta_j = \mathrm{pct}_{\text{site}, j} - \mathrm{pct}_{\text{city}, j}, \quad \text{both among the candidates both calls ranked}`,
    plain_english:
      "How much higher a candidate ranks among the same candidates when the site's location is the signal than when the whole city is: each call is re-ranked over the candidates both scored. Positive means the site suits it better than the city at large. A candidate one call did not score has no shift.",
    caveats: [WITHIN_CALL, "Commercial concept fit only."],
  },
  "tenant.fit": {
    name: "Tenant fit",
    formula_tex: String.raw`\mathrm{TenantFit}_j = 100 \cdot \big( 0.6 \cdot \mathrm{pct}_{\text{site}, j} + 0.4 \cdot \operatorname{clip}(\Delta_j + 0.5,\ 0,\ 1) \big)`,
    plain_english:
      "A 0 to 100 fit score: 60% from the candidate's percentile at the site and 40% from how much better it ranks at the site than in the city. It is the only weighted formula in the product, and its weights are a fixed design choice shown here.",
    caveats: [
      "Taste fit for a commercial concept; not credit, rent capacity, sales, or any decision about a business owner or resident.",
      "The weights are not fitted to outcomes.",
      "Because it also weighs the rise over the city, tenant fit can order two candidates the other way round from their site rank; tables state which order they are sorted by.",
      WITHIN_CALL,
    ],
  },
  "rank.shift": {
    name: "Rank shift (between contexts)",
    formula_tex: String.raw`\Delta_j = \mathrm{pct}_{\text{last}, j} - \mathrm{pct}_{\text{first}, j}, \quad \text{both among the candidates every compared context ranked}`,
    plain_english:
      "How much higher a candidate ranks in the last context of a slope than in the first, among the same candidates: each call is re-ranked over the candidates every compared context scored. Positive means it climbs from the first context to the last. A candidate one of the compared contexts did not score has no shift.",
    caveats: [
      "Ranks are compared across calls, never raw affinities.",
      UNSCORED,
      METRO,
      "A shift among a few common candidates moves in large steps; read it with the set size.",
    ],
  },
  "xdom.under_the_radar": {
    name: "UNDER-THE-RADAR (cultural neighbourhood)",
    formula_tex: String.raw`U_n = A_n - p_n, \quad \text{pick} = \arg\max_{n:\ A_n \ge \operatorname{median}(A),\ p_n < \min(\operatorname{median}(p),\, 0.85),\ U_n > 0} U_n`,
    plain_english:
      "Fit minus popularity: high when the audience's taste points strongly to something that is not yet widely popular. A domain's under-the-radar pick is its highest score among results with fit at or above the domain's median fit, popularity below its median popularity and popularity below 0.85; a domain where no result clears that bar has no pick.",
    caveats: [
      NO_PRICE,
      "It subtracts a global popularity from a within-call percentile, so read it as an ordering inside one domain.",
      "The call caps popularity, so the most popular entities are not in the list.",
      "The medians are relative to this list: a pick is less popular than most of its neighbours, not obscure.",
    ],
  },
  "xdom.edge": {
    name: "Explainability edge",
    formula_tex: String.raw`\text{edge}(s, n) \iff K \ge 2 \ \wedge\ \mathrm{share}_{s,n} \cdot K \ge 1.1, \quad K = \text{number of seeds}`,
    plain_english:
      "A line from a seed to a result is drawn only when that seed's share of Qloo's explanation is clearly above an even split. Otherwise the result shows its affinity only and the shares appear in the tooltip.",
    caveats: [
      "Explainability is attribution inside Qloo's model, not causation.",
      "Most results split almost evenly across seeds and get no edge.",
    ],
  },
  "xdom.partners_one_category": {
    name: "Partners in one category (brand collaboration)",
    formula_tex: String.raw`\text{fires} \iff N \ge 5 \ \wedge\ \max_c N_c / N \ge 0.6, \quad N = \text{scored partners},\ N_c = \text{partners in top-level brand category } c`,
    plain_english:
      "When at least 60% of at least five scored partner brands sit in one top-level brand category (after the subject's own category is left out), discovery has clustered. The suggested next step is a sponsor slate seeded by the subject over up to six sponsor categories the partners do not cover, so the note can name a best fit in each other category.",
    caveats: [
      "A rule: it decides the next step and produces no number of its own.",
      "Categories are Qloo's genre:brand branches; a partner without one is counted but sits in no category.",
      "A sponsor category without a verified tag is never suggested.",
    ],
  },
  "slate.best_fit": {
    name: "Best fit per category",
    formula_tex: String.raw`j^{*}_{c} = \arg\max_{j \in c} A_j, \quad A_j = \text{percentile in the one-scale scoring call}`,
    plain_english:
      "The sponsor candidate with the highest fit in each category, all scored against the same seed in one call, so the slate holds one beer, one spirit and so on.",
    caveats: [
      "Taste fit only; Qloo has no fee, availability or exclusivity data.",
      "No ROI estimate.",
      WITHIN_CALL,
    ],
  },
  "slate.under_the_radar": {
    name: "UNDER-THE-RADAR fit (sponsor)",
    formula_tex: String.raw`\mathrm{UTR}_j \iff A_j \ge \operatorname{median}(A) \ \wedge\ p_j < \min(\operatorname{median}(p),\, 0.85)`,
    plain_english:
      "A candidate is flagged under the radar when its fit is at or above the slate's median fit while its popularity is below the slate's median popularity and below 0.85. A better-known name is never flagged, however the slate's median falls.",
    caveats: [NO_PRICE, "Relative to this slate; a different shortlist moves both medians."],
  },
  "slate.market_alignment": {
    name: "Market alignment",
    formula_tex: String.raw`\Delta_{jm} = \mathrm{pct}_{jm} - A^{(m)}_j, \quad A^{(m)}_j = \text{national percentile of } j \text{ among } S_m`,
    plain_english:
      "How much higher a sponsor candidate ranks when the seed's taste is read in metro m than nationally, among the same brands: S_m, the slate brands the metro call scored. Positive means the market leans toward that candidate. A metro that scored fewer than three slate brands gives no value.",
    caveats: [METRO, "Read within the brands the metro scored, often a few of the slate; a brand the metro dropped is not scored there."],
  },
  "twin.rho": {
    name: "Taste twin resemblance (Spearman rho)",
    formula_tex: String.raw`\rho_a = \operatorname{Spearman}\big(\Delta_{\text{src}}(t),\ \Delta_a(t)\big)_{t \in U}, \quad \Delta_x(t) = \mathrm{rank}_{\text{city}(x)}(t) - \mathrm{rank}_x(t)`,
    plain_english:
      "How alike two areas in different cities are in the way each differs from its own city. For every tag in either area's comparison, take its rank gain over its city (a missing rank counts as 51) and correlate the two lists of gains by rank: 1 means the same tags over- and under-index in both areas, 0 means no relation, below 0 means opposite patterns. At least 8 tags are needed. The more tags the two area lists share, the more the value can be trusted.",
    caveats: [
      VENUE_GOERS,
      "Ranks only the areas checked (named, picked by concept lift, or the largest), not every area of the target city.",
      "Music tags (SOUND) are not compared.",
      "Similar taste, not a forecast of sales, rents or footfall.",
    ],
  },
  "twin.shared_new": {
    name: "Shared NEW tags",
    formula_tex: String.raw`\mathrm{SharedNew}_a = \big|\{t : t \text{ NEW in the source area} \wedge t \text{ NEW in } a\}\big|`,
    plain_english:
      "Tags that both areas hold in their top 20 while their own cities' top-50 lists do not: the most distinctive taste the two areas have in common.",
    caveats: [VENUE_GOERS],
  },
  "cnpt.s50": {
    name: "Concept anchor (s50)",
    formula_tex: String.raw`s_{50} = \text{the 50th result of the open concept call, scored again inside the scoring call}`,
    plain_english:
      "The bar an analog has to clear: the entity that ranks 50th when Qloo is asked for the concept's tags alone. It is scored again in the same call as the analogs, so the comparison never crosses calls. With fewer than 50 results, the last scored result is the anchor.",
    caveats: [WITHIN_CALL, "The anchor depends on the concept tags chosen; other tags give another anchor."],
  },
  "cnpt.verdict": {
    name: "KEEP / VETO / ADD",
    formula_tex: String.raw`\text{KEEP} \iff A_j \ge A_{s_{50}}, \quad \text{VETO} \iff A_j < A_{s_{50}}, \quad A = \text{affinity in the same scoring call}`,
    plain_english:
      "An analog is kept when the concept's taste scores it at least as high as the anchor (the concept's 50th result), and vetoed when it scores lower. An analog Qloo returns no score for, or one at the call's shared floor value, is not scored: never a VETO. ADD lists the concept's top results you did not name.",
    caveats: [WITHIN_CALL, UNSCORED, "A VETO means the concept's taste points elsewhere, not that the analog is a weak business.", NOT_SALES],
  },
  "cnpt.precision": {
    name: "Analog precision",
    formula_tex: String.raw`\mathrm{Precision} = \frac{\#\text{KEEP}}{\#\text{KEEP} + \#\text{VETO}}`,
    plain_english: "The share of your scored analogs that the concept's taste keeps. Analogs without a score do not count either way.",
    caveats: ["A share of a few analogs moves in large steps; read it with the count (k of n)."],
  },
  "fin.revenue": {
    name: "Reported revenue",
    formula_tex: String.raw`R_p = \text{the first revenue line the company reports for period } p`,
    plain_english:
      "Revenue for one fiscal year (10-K) or one quarter (10-Q) as the company reported it, taking the first revenue line it reports for the period in this order: revenue from contracts with customers excluding assessed tax, revenues, net sales revenue, revenue from contracts with customers including assessed tax. When a later filing restates a period, the latest-filed value is used.",
    caveats: [REPORTED, COMPANY_WIDE, "A company that changes its revenue line between years is compared as reported."],
  },
  "fin.margin": {
    name: "Gross and operating margin",
    formula_tex: String.raw`\mathrm{GM}_p = \frac{\mathrm{GrossProfit}_p}{R_p}, \quad \mathrm{OM}_p = \frac{\mathrm{OperatingIncomeLoss}_p}{R_p}`,
    plain_english:
      "Gross profit and operating income as a share of revenue for the same reported period. A company that does not report gross profit has no gross margin; it is shown as not reported, never as 0.",
    caveats: [REPORTED, COMPANY_WIDE],
  },
  "fin.yoy": {
    name: "Year-over-year revenue change",
    formula_tex: String.raw`\mathrm{YoY}_p = \frac{R_p}{R_{p - 1\,\text{yr}}} - 1`,
    plain_english:
      "How much revenue changed against the same period a year earlier (a fiscal year against the one before, a quarter against the same quarter a year before), both as reported.",
    caveats: [REPORTED, COMPANY_WIDE, "Acquisitions, disposals and currency moves are included as reported, not adjusted."],
  },
  "econ.count": {
    name: "Area count (residents, households, workers)",
    formula_tex: String.raw`N_A = \sum_{u \in A} N_u, \quad u = \text{the ZIP code tabulation areas or census tracts of area } A`,
    plain_english:
      "Population, households and workers of an area: the Census estimates of the ZIP areas or census tracts inside it, added up. Where an area is only part of a ZIP area, the whole ZIP area's figures are used, so they describe more than the area.",
    caveats: [ACS, "Units whose estimate Census withheld are left out of the sum, and the answer says so."],
  },
  "econ.median": {
    name: "Area median (approximate)",
    formula_tex: String.raw`\tilde m_A = \frac{\sum_{u \in A} P_u\, m_u}{\sum_{u \in A} P_u}, \quad P_u = \text{population of unit } u`,
    plain_english:
      "Median age and median household income of an area made of several Census units: the population-weighted average of the units' medians. It approximates the area's true median, which Census does not publish for our areas, so it is badged approximate. An area of one unit shows that unit's published median.",
    caveats: [ACS, "An average of medians is not the median of the combined area."],
  },
  "econ.share": {
    name: "Commute mode share",
    formula_tex: String.raw`\mathrm{share}_{A, k} = \frac{\sum_{u \in A} W_{u, k}}{\sum_{u \in A} W_u}, \quad W = \text{workers 16 and over}`,
    plain_english:
      "The share of an area's resident workers who usually drive alone, take public transit, walk, cycle or work from home.",
    caveats: [ACS, "About how residents get to work, not about who visits the area."],
  },
  "osm.count": {
    name: "Places counted (OpenStreetMap)",
    formula_tex: String.raw`N_{A,t} = \#\{\, e \in \mathrm{OSM} : e \text{ matches type } t,\ e \text{ inside area } A \,\}`,
    plain_english:
      "How many places of a type (such as cafés) are mapped in OpenStreetMap inside a neighbourhood outline, or within 5 km of a market's centre. Nodes, ways and relations all count; the tags each type matches are listed in the method's tag table.",
    caveats: [OSM_FLOOR, OSM_NOT_DEMAND, "A place mapped twice (as a point and as a building) can count twice; this is rare."],
  },
  "osm.density": {
    name: "Places per square kilometre",
    formula_tex: String.raw`D_{A,t} = N_{A,t} / \mathrm{km}^2_A`,
    plain_english:
      "The count divided by the area's land size, so areas of different sizes compare fairly. A market's area is the circle of its 5 km radius.",
    caveats: [OSM_FLOOR, "Neighbourhood sizes come from our gazetteer outlines and are approximate."],
  },
  "osm.density_index": {
    name: "Against the city",
    formula_tex: String.raw`I_{A,t} = D_{A,t} / D_{\text{city},t}, \quad \text{about the city's level when } 0.8 \le I \le 1.25`,
    plain_english:
      "An area's density of a place type divided by its city's: 1 is the city's level, 2 is twice as dense. Between 0.8 and 1.25 it reads about the city's level. At 1.5 or more with at least 5 places, and at least 1.25 times the area's street-activity index (so the type is a larger share of its shops and food and drink places than in the city, not just part of a denser street), the area has more of that type than its city (oversupplied); at 0.5 or less while the city has some, and below 0.8 times its street-activity index, it has less (undersupplied).",
    caveats: [OSM_FLOOR, OSM_CITY, "Mapping completeness differs between areas, which moves the index too."],
  },
  "osm.activity_density": {
    name: "Street activity",
    formula_tex: String.raw`S_A = \frac{\#\{\text{shops, food and drink places in } A\}}{\mathrm{km}^2_A}`,
    plain_english:
      "All mapped shops and food and drink places per square kilometre: a rough measure of how much street-level commerce an area has. Below 0.3 of the city's level the area reads low street activity.",
    caveats: [OSM_FLOOR, OSM_NOT_DEMAND],
  },
  "screen.universe": {
    name: "Screened set",
    formula_tex: String.raw`U = \text{the first } n \text{ brands of the discovery call for the category tag or the seed brand}, \quad n \le 25`,
    plain_english:
      "The brands a screen ranks: the top results Qloo returns for brands with the category's tag, or for brands whose audience taste is near the seed brand. Every column then reads this same set, so ranks and percentiles compare these brands only.",
    caveats: [
      "Brands outside the first results are not screened; a brand missing from Qloo's dataset cannot appear.",
      "A different category tag or seed gives a different set.",
      NOT_SALES,
    ],
  },
  "screen.under_the_radar": {
    name: "UNDER-THE-RADAR (screener)",
    formula_tex: String.raw`U_j = \mathrm{FIT}_j - p_j, \quad \text{flag} \iff \mathrm{FIT}_j \ge \operatorname{median}(\mathrm{FIT}) \ \wedge\ p_j < \min(\operatorname{median}(p),\, 0.85)`,
    plain_english:
      "Fit minus popularity for each screened brand: high when the category's (or the seed's) taste points strongly to a brand that is not yet widely popular. A brand is flagged under the radar when its fit is at or above the set's median fit while its popularity is below the set's median and below 0.85, so a mass-market name is never flagged.",
    caveats: [
      NO_PRICE,
      "It subtracts a global popularity from a within-call percentile, so read it as an ordering inside this screen.",
      "The medians are relative to this set: a flagged brand is less popular than most of the set, not obscure.",
      "A brand the scoring call did not score has no value, never 0.",
    ],
  },
  taste_map_mds: {
    name: "Category Taste Map (classical MDS)",
    formula_tex: String.raw`d_{ij} = 1 - \mathrm{sim}_{ij}, \quad B = -\tfrac{1}{2} J D^{(2)} J, \quad X = V_2 \Lambda_2^{1/2}, \quad \text{stress} = \sqrt{\frac{\sum_{i<j} (d_{ij} - \lVert x_i - x_j \rVert)^2}{\sum_{i<j} d_{ij}^2}}`,
    plain_english:
      "Places up to 14 entities on a flat map so that the distance between two points approximates how different their audiences' taste is (one minus their pairwise similarity). It is classical multidimensional scaling: the two largest eigenvectors of the double-centred squared distances. Pairs Qloo did not score are set to the largest scored distance, and the map lists them. Stress says how well the flat map keeps the distances: 0 is exact, above 0.2 reads as a poor fit and the map says so.",
    caveats: [
      "Only distances between points mean anything; the axes, the rotation and the scale do not.",
      "Audience taste similarity, not switching, share or sales.",
      PEER_SET,
      "Two dimensions cannot keep every distance; read close pairs, not exact positions.",
    ],
  },
  "confidence.run": {
    name: "Run confidence",
    formula_tex: String.raw`C = \min\!\Big(\max\!\big(0,\ 100 - 15\,n_{\text{dropped}} - 10\,n_{\text{fallback}} - 10\,[\text{coarse}] - 20\,[\text{stale momentum cited}] - 10\,n_{\text{thin}} - 5\,n_{\text{gate}} - 5\,n_{\text{warn}} - 60\,[\text{insufficient}] - 5\,[\text{nearest job}]\big),\ \min_{r \text{ fired}} \mathrm{cap}_r\Big)`,
    plain_english:
      "Starts at 100 and loses points for each weakness: 15 per dropped or unresolved secondary entity, 10 per code fallback, 10 for a coarse map, 20 when stale-only momentum is cited, 10 per thin result (fewer than 5 rows), 5 per quality-gate drop, 5 per CHECKER warning, 60 when there is too little evidence to read a signal, and 5 when the question was read as the closest kind of question Culture Terminal answers. Then caps tie it to the strength of the signal: a mixed signal caps it at 70 (never HIGH), a weak signal at 45 (LOW), a headline resting on a small sample at 70, a concept read only at its broader category at 60, and a partly tested concept at 70. HIGH is 75 or more, MED 50 to 74, LOW below 50. The breakdown shows on hover.",
    caveats: [
      "Measures the completeness and quality of this run's evidence, not the probability that the conclusion is right.",
      "Computed by code from the run's flags; the model cannot change it.",
    ],
  },
  "confidence.metric": {
    name: "Metric confidence",
    formula_tex: String.raw`\mathrm{conf} = m_{\text{badge}} \cdot \big(1 - 1/\sqrt{n}\big), \quad \text{clamped to } [0, 1]`,
    plain_english:
      "The evidence strength behind one number: a weight for its badge (measured data counts most) times a factor that grows with the number of observations n behind it. It drives the STRONG, MODERATE and THIN pills. A reported SEC or Census figure has no sample size, so its pill comes from its source and badge instead: a reported or exactly derived figure is STRONG, an approximate one (an area apportioned from tracts or ZIP areas) MODERATE.",
    caveats: [
      "An UNAVAILABLE metric has no confidence, and a single observation gives zero.",
      "Strength of evidence, not the size or direction of the effect.",
    ],
  },
};

// Built from FORMULA_IDS so the record holds exactly the frozen ids, each entry carrying its own id.
export const FORMULAS: Readonly<Record<FormulaId, Formula>> = Object.freeze(
  Object.fromEntries(FORMULA_IDS.map((id) => [id, Object.freeze({ id, ...BODIES[id] })])) as Record<FormulaId, Formula>,
);

export function isFormulaId(value: string): value is FormulaId {
  return (FORMULA_IDS as readonly string[]).includes(value);
}


// Thresholds that live in one place (Part 11, DESIGN 1.7) ----------------------------------------------

/**
 * When a value rests on a thin sample (Metric.thin, R1): a one-scale ranked, slate, creator or partner set
 * of fewer than 5 rows; a share or pair percentile from a 2-entity set; an area lift with confidence below
 * 0.5 or fewer than 12 gated cells; a Block DNA area list of fewer than 20 tags; fewer than 4 scored
 * concept analogs; a twin correlation on fewer than 12 shared tags. A thin metric behind the headline caps
 * confidence at MED (thin_sample).
 */
export const THIN_SAMPLE = {
  rankedRows: 5,
  pairEntities: 2,
  liftConf: 0.5,
  liftCells: 12,
  blockTags: 20,
  conceptAnalogs: 4,
  twinSharedTags: 12,
} as const;

/**
 * The about-level band (Metric.level, V13): differences this small read "about average" / "about level",
 * never "leans", "wins" or "gains", and cannot lead an answer. A rank gain of at most
 * max(2, ceil(5% of the list)) places is about level, so "+1 of 50" and "+2 of 50" never read as a win.
 */
export const ABOUT_LEVEL = {
  audienceIndex: 0.1,
  youthTilt: 0.1,
  pctDelta: 0.05,
  rankGainMinPlaces: 2,
  rankGainShare: 0.05,
  densityIndexLow: 0.8,
  densityIndexHigh: 1.25,
} as const;

/** Area standing (R7, D50): top quarter and bottom half of the within-call percentiles. */
export const STANDING = { top: 0.75, low: 0.5 } as const;

/** OpenStreetMap supply findings (R6): over/under the city's density and low street activity. */
/**
 * Supply labels (R6). A dense commercial core is denser than its city in nearly every type, so a type is
 * "more of than the city" only when its index also beats the area's street-activity index by `beyondActivity`
 * (a larger share of the area's shops and food and drink places than in the city), and "less of" only when it
 * falls below it by `belowActivity`. Without a street-activity reading the plain index rule applies.
 */
export const SUPPLY = { overIndex: 1.5, underIndex: 0.5, minCount: 5, lowActivityShare: 0.3, beyondActivity: 1.25, belowActivity: 0.8 } as const;

const LEVEL_EPS = 1e-9;
const isNum = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);

/** |audience index| or |index delta| inside the about-level band (−1..1 scale). */
export function isAboutLevelIndex(value: number | null | undefined): boolean {
  return isNum(value) && Math.abs(value) < ABOUT_LEVEL.audienceIndex - LEVEL_EPS;
}

/** |youth tilt| inside the about-level band. */
export function isAboutLevelTilt(value: number | null | undefined): boolean {
  return isNum(value) && Math.abs(value) < ABOUT_LEVEL.youthTilt - LEVEL_EPS;
}

/** |percentile delta| inside the about-level band. */
export function isAboutLevelPctDelta(value: number | null | undefined): boolean {
  return isNum(value) && Math.abs(value) < ABOUT_LEVEL.pctDelta - LEVEL_EPS;
}

/** The most places a rank may move and still read about level, for a list of `listLength` rows. */
export function aboutLevelRankPlaces(listLength: number): number {
  const n = Number.isFinite(listLength) && listLength > 0 ? listLength : 0;
  return Math.max(ABOUT_LEVEL.rankGainMinPlaces, Math.ceil(ABOUT_LEVEL.rankGainShare * n - LEVEL_EPS));
}

/** A rank gain or loss of at most aboutLevelRankPlaces(listLength) places ("+1 of 50" is about level). */
export function isAboutLevelRankGain(places: number | null | undefined, listLength: number): boolean {
  return isNum(places) && Math.abs(places) <= aboutLevelRankPlaces(listLength);
}

/** An OSM density index inside [0.8, 1.25]: about the city's level. */
export function isAboutLevelDensityIndex(value: number | null | undefined): boolean {
  return isNum(value) && value >= ABOUT_LEVEL.densityIndexLow - LEVEL_EPS && value <= ABOUT_LEVEL.densityIndexHigh + LEVEL_EPS;
}

/**
 * Area standing from the raw-popularity percentile and the lift (demand) percentile: popular = top quarter
 * of raw popularity without top-quarter lift; hidden = top-quarter lift and bottom-half popularity;
 * popular_distinct = top quarter on both; else null (also when the raw percentile is unknown).
 */
export function areaStanding(rawPct: number | null, demandPct: number | null): "popular" | "hidden" | "popular_distinct" | null {
  if (!isNum(rawPct)) return null;
  const highRaw = rawPct >= STANDING.top - LEVEL_EPS;
  const highDemand = isNum(demandPct) && demandPct >= STANDING.top - LEVEL_EPS;
  if (highRaw && highDemand) return "popular_distinct";
  if (highRaw) return "popular";
  if (highDemand && rawPct < STANDING.low - LEVEL_EPS) return "hidden";
  return null;
}
