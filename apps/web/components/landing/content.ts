/**
 * The copy of the marketing landing (/welcome). Everything here is true of the product today
 * (functional spec §3.0): no example questions, no showcase answers, no prices. The product visuals
 * are illustrations with invented brands and figures and say so.
 */

export const LANDING_META = {
  title: "Culture Terminal · Taste research for business teams",
  description:
    "Ask one question in plain English and get a one-page answer in about a minute, built from Qloo taste data, SEC EDGAR, US Census ACS and OpenStreetMap. Every number is computed in code and traced to its source.",
} as const;

/** Where the calls to action go: a free account first, then the ask box on Home. */
export const ASK_HREF = "/";
export const START_LABEL = "Start asking";
export const SIGNUP_HREF = "/signup";
export const SIGNUP_LABEL = "Create account";
export const LOGIN_HREF = "/login";
export const LOGIN_LABEL = "Sign in";

export const NAV_LINKS: readonly { label: string; href: string }[] = [
  { label: "Product", href: "#product" },
  { label: "How it works", href: "#how" },
  { label: "Desks", href: "#desks" },
  { label: "Honesty", href: "#honesty" },
  { label: "Limits", href: "#limits" },
  { label: "Method", href: "/method" },
];

export const HERO = {
  eyebrow: "Taste research for business teams",
  title: "Know what your audience loves, and where, before you commit the budget.",
  lead: "Ask one question in plain English. In about a minute you get a one-page answer with a verdict, maps and charts. Every number is computed in code and traced to the request that produced it.",
  secondary: "See how it works",
  visualAlt:
    "An answer page: a verdict with rule-scored confidence, a neighbourhood lift map of Chicago, three key numbers, the guesses written before the data, and what AI alone would have said.",
  visualNote: "Illustration. The brand and figures are invented.",
} as const;

export const SOURCES_TITLE = "What every answer is built from";

export const SOURCES: readonly { name: string; text: string }[] = [
  { name: "Qloo taste data", text: "Group-level affinity across brands, places, music, film, TV and podcasts" },
  { name: "US Census ACS", text: "Who lives in an area: residents, not customers" },
  { name: "SEC EDGAR", text: "Reported company financials, company-wide" },
  { name: "OpenStreetMap", text: "Counts of nearby places. A floor, never a full list" },
  { name: "The web, dated", text: "Publisher, title and date on every finding. Shown apart, never verified" },
];

export const HOW = {
  eyebrow: "How it works",
  title: "One question in. A one-page answer out, with the working shown.",
  lead: "No pickers, no dashboard to configure. Ask the way you would ask a colleague.",
} as const;

export interface LandingStep {
  n: string;
  title: string;
  text: string;
}

export const STEPS: readonly LandingStep[] = [
  {
    n: "01",
    title: "Ask in plain English",
    text: "Up to 400 characters, read into one of 13 jobs. Names are matched exactly; if one is ambiguous, you pick.",
  },
  {
    n: "02",
    title: "Watch it work",
    text: "About a minute, step by step: the opening scan, guesses written before any data, follow-ups the data triggers. Stop at any time.",
  },
  {
    n: "03",
    title: "Get the answer, with proof",
    text: "A verdict, rule-scored confidence, key numbers, maps and charts. Every number opens to the request behind it.",
  },
];

export const DESKS_HEAD = {
  eyebrow: "Four desks · thirteen jobs",
  title: "Built for the teams who put money behind a guess about taste.",
} as const;

export interface LandingDesk {
  id: "brands" | "places" | "tours" | "audiences";
  eyebrow: string;
  title: string;
  text: string;
  jobs: readonly { name: string; code: string }[];
  limit: string;
  image: string;
  imageAlt: string;
}

export const DESKS: readonly LandingDesk[] = [
  {
    id: "brands",
    eyebrow: "01 · Brands & investing",
    title: "For investors and brand strategy",
    text: "See which brands really share an audience, how two brands split cities and age groups, and whether a new product idea has a home. Reported SEC figures sit beside the taste data, company-wide.",
    jobs: [
      { name: "Real competitors", code: "HLTH" },
      { name: "Compare two brands", code: "VS" },
      { name: "Test a new product", code: "LNCH" },
    ],
    limit: "Not financial advice. No buy, sell or price calls.",
    image: "/landing/desk-brands.webp",
    imageAlt: "Outdoor gear on a shelf, with a chart of the closest audiences to an invented outdoor brand.",
  },
  {
    id: "places",
    eyebrow: "02 · Places",
    title: "For location and real-estate strategy",
    text: "Find the neighbourhood whose residents' taste fits your concept, the best tenant for a corner, an area's closest twin, or what sets two to four cities apart. Census and OpenStreetMap counts add who lives there and who is already open.",
    jobs: [
      { name: "Where to open", code: "SITE" },
      { name: "Best tenant for a space", code: "TEN" },
      { name: "Read a neighbourhood", code: "DNA" },
      { name: "Find an area's twin", code: "TWIN" },
      { name: "Compare cities", code: "CITY" },
    ],
    limit: "Shared taste, not foot traffic, rents or sales.",
    image: "/landing/desk-places.webp",
    imageAlt: "A city street with shopfronts, with a chart of neighbourhood lift against the city baseline.",
  },
  {
    id: "tours",
    eyebrow: "03 · Sponsors & tours",
    title: "For marketing, sponsorship and touring",
    text: "Score sponsors and partners on audience fit, pick launch and tour cities, and find artists and podcasts whose fans look like yours.",
    jobs: [
      { name: "Sponsor fit", code: "SPON" },
      { name: "Launch & tour cities", code: "MKTS" },
      { name: "Brand collaborations", code: "COLLAB" },
      { name: "Artists & podcasts who fit", code: "CRTR" },
    ],
    limit: "Fit only. No fees, pricing or ROI.",
    image: "/landing/desk-sponsors.webp",
    imageAlt: "A live event crowd, with a chart of best-fit partners for an invented fitness brand.",
  },
  {
    id: "audiences",
    eyebrow: "04 · Audiences",
    title: "For audience research",
    text: "Who the fans are, how they lean by age and gender, and what else they love, from brands to films to podcasts. Group-level only, never individuals.",
    jobs: [{ name: "Who they are", code: "AUD" }],
    limit: "No individuals and no sensitive traits.",
    image: "/landing/desk-audiences.webp",
    imageAlt: "People in conversation, with a chart of an invented brand's fans by age against the US average.",
  },
];

export const ALSO_TITLE = "Also included, no AI model involved";

export const ALSO: readonly { title: string; text: string; href: string }[] = [
  {
    title: "Audience profiles",
    text: "A one-page profile of any brand, artist, public figure, podcast, TV show or film: who the fans are and what else they love.",
    href: "/d",
  },
  {
    title: "Brand screener",
    text: "Rank 5 to 25 brands by audience fit across up to four markets, straight from the data.",
    href: "/screener",
  },
  {
    title: "Following",
    text: "Keep a brand, place or question with its latest note and re-run it when you choose. No alerts, and no claims that something changed.",
    href: "/following",
  },
];

export const FIGURES = {
  eyebrow: "The figures",
  title: "Maps, tables and grids you can put in front of a board.",
  lead: "Each chart states its limit. Each value opens to its request. Missing data is named, never drawn as zero.",
  mapAlt:
    "A neighbourhood lift map of Chicago with a layer switcher, a colour legend from below to above the city baseline, and a ranked list of areas.",
  tableAlt:
    "A ranked table of Austin areas by lift, affinity and share, and a heatmap of five audiences against six taste categories with thin cells left blank.",
} as const;

export const HONESTY = {
  eyebrow: "Honest by construction",
  title: "We say what we do not know.",
  lead: "An answer is only worth acting on if you can see where it is thin.",
} as const;

export const HONESTY_POINTS: readonly { title: string; text: string }[] = [
  {
    title: "The AI never types a number",
    text: "Every figure is computed in code and traced to a logged request. A checker reads the page and states that every number was checked, or says which were not.",
  },
  {
    title: "Confidence rates the data",
    text: "It is scored by fixed rules, not by how sure the model sounds. You see what lowered it and the caps it hit. It is not the chance of being right.",
  },
  {
    title: "Missing data stays missing",
    text: "No zeros, no flat lines, no guesses filled in. A gap is named in words with the reason.",
  },
  {
    title: "AI alone, shown beside the data",
    text: "Each answer shows what a model alone would have said, and the analyst's guesses written before the data, scored after.",
  },
];

export const APART = {
  label: "Shown apart from the measured answer",
  aiTitle: "What AI knows (not verified)",
  aiSub: "Model knowledge · no figures",
  aiText:
    "Background the model already knows about the brand or place, written in words and kept out of the numbers.",
  webTitle: "From the web",
  webSub: "Dated findings",
  webText: "Each finding names its publisher, title and date. It never changes the measured answer.",
  confTitle: "Confidence: rule-scored",
  confText: "Rates the data behind this answer, not the chance it is right. The page lists what lowered it.",
} as const;

export const DONT_TITLE = "What we don't do";
export const DONT: readonly string[] = [
  "No individuals, only groups",
  "No politics, religion, health, ethnicity or other sensitive traits",
  "No housing, credit, job or insurance decisions",
  "No buy, sell or price advice",
];

export const CANNOT_TITLE = "What the data cannot tell you";
export const CANNOT: readonly string[] = [
  "Affinity is shared taste, not sales",
  "No sales, prices, rents or foot traffic",
  "Census describes residents; SEC is company-wide",
  "OpenStreetMap counts are a floor, not a full list",
];

export const LIMITS = {
  eyebrow: "Limits and access",
  title: "Plain limits, written down before you hit them.",
  planName: "Early access",
  planText: "Every desk, every figure, every source.",
  planBadge: "Open now",
  rows: [
    { a: "New answers", b: "A daily and an hourly allowance, plus a cap on runs at once" },
    { a: "Answers you already have", b: "Reopen any time, no limit" },
    { a: "Following, screener and profiles", b: "Each has its own allowance, stated where you use it" },
    { a: "Each answer", b: "About a minute. If a run stops early, the page says what is missing" },
  ],
  planLink: "See your current numbers in Settings",
  planHref: "/settings",
  note: "Paid plans with higher limits are not open yet. When they are, this page will say so first.",
} as const;

export const COVERAGE = {
  title: "Coverage",
  stats: [
    { n: "13", label: "cities with neighbourhood maps" },
    { n: "51", label: "US cities at market level" },
  ],
  cities:
    "Atlanta, Austin, Boston, Chicago, Dallas, Denver, Houston, Los Angeles, Miami, Nashville, New York City, San Francisco, Seattle",
  notes: [
    "Trends over time for brands and TV only",
    "Profiles for brands, artists, public figures, podcasts, TV shows and films",
    "Other places are named as not covered, never swapped for a nearby one",
  ],
} as const;

export const FAQ_HEAD = {
  eyebrow: "Questions",
  title: "What buyers ask before they start.",
  lead: "For analysts: every formula and rule is published.",
  link: "Read the method",
} as const;

export const FAQ: readonly { q: string; a: string }[] = [
  {
    q: "Where does the data come from?",
    a: "Group-level taste data from Qloo, US Census ACS, SEC EDGAR filings and OpenStreetMap place counts. Web findings, when shown, carry their publisher and dates and sit apart from the measured answer.",
  },
  {
    q: "Can the AI make up a number?",
    a: "No. The model writes words and placeholders; code computes every figure. Before you see the page, a checker traces each number to the logged request that produced it, and says plainly if any could not be traced.",
  },
  {
    q: "What does the confidence level mean?",
    a: "It rates the data behind the answer: how complete and fresh it is. Fixed rules set it, and the model cannot raise it. It is not the chance that the answer is right.",
  },
  {
    q: "Do you have data on individuals?",
    a: "No. All taste data is group-level. We never answer about a person, and we decline questions about sensitive traits before any data is fetched.",
  },
  {
    q: "Which places are covered?",
    a: "Neighbourhoods in 13 US cities and 51 US cities at market level. A place outside coverage is named as not covered, never swapped for a nearby one.",
  },
  {
    q: "Can I use it for investment decisions?",
    a: "It can inform research: reported SEC figures sit beside the taste data, company-wide. It gives no buy, sell or price advice, and affinity is shared taste, not sales.",
  },
];

export const FINAL = {
  title: "Ask the question you would otherwise guess at.",
  lead: "One plain-English question. A one-page answer in about a minute, with every number traced.",
  secondary: "Read the method",
} as const;

export const FOOTER_COLUMNS: readonly { title: string; links: readonly { label: string; href: string }[] }[] = [
  {
    title: "Product",
    links: [
      { label: "How it works", href: "#how" },
      { label: "Desks", href: "#desks" },
      { label: "Limits", href: "#limits" },
      { label: "Create account", href: "/signup" },
      { label: "Sign in", href: "/login" },
    ],
  },
  {
    title: "For analysts",
    links: [
      { label: "Method", href: "/method" },
      { label: "How answers are made", href: "/how-it-works" },
      { label: "Trust", href: "/trust" },
      { label: "Status", href: "/status" },
    ],
  },
];

export const FOOTER_NOTES = {
  caption: "Group-level taste data from Qloo · No individuals · Not financial advice",
  licences:
    "Map data © OpenStreetMap contributors (ODbL) · This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau",
} as const;
