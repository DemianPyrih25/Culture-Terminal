// /d/[entity] and /d rendered on the server: noindex unless a curated entity's tearsheet is drawn (D31),
// the tearsheet's sections, figures and receipts, each state's card, and the search box. The lookup is
// stubbed where the page loads it; the tearsheet itself comes from the service on the Qloo mock. Invented
// entities only (D29).
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesType } from "../../components/des/des-href";
import type { DesOutcome, Tearsheet } from "../../components/des/model";
import { desDeps, OPEN_LIMITS, request } from "./support";

const { loadTearsheet, redirect } = vi.hoisted(() => ({
  loadTearsheet: vi.fn<(name: string, type: DesType, pick: string | null) => Promise<DesOutcome>>(),
  redirect: vi.fn((href: string) => {
    throw new Error(`NEXT_REDIRECT ${href}`);
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), redirect }));
vi.mock("../../components/ask/top-bar-ask", () => ({ TopBarAsk: () => null }));
vi.mock("../../app/d/[entity]/load", () => ({ loadTearsheet }));
// Juniper Cola (a brand) and Comedian Vega (a person) stand for curated showcase entities, as the config
// spells them; every other name is a reader's own lookup.
vi.mock("../../server/des/curated", () => {
  const curated = [
    { name: "Juniper Cola", type: "brand" },
    { name: "Comedian Vega", type: "person" },
  ];
  const curatedEntity = (name: string, type: string) =>
    curated.find((e) => e.type === type && e.name.toLowerCase() === name.replace(/\s+/g, " ").trim().toLowerCase()) ?? null;
  return { curatedEntity, isCurated: (name: string, type: string) => curatedEntity(name, type) !== null };
});

const { default: DesPage, generateMetadata } = await import("../../app/d/[entity]/page");
const { default: DesSearchPage } = await import("../../app/d/page");
const { DesService } = await import("../../server/des/service");

const NOINDEX = { index: false, follow: false };

const props = (entity: string, search: Record<string, string> = {}) =>
  ({ params: Promise.resolve({ entity }), searchParams: Promise.resolve(search) }) as PageProps<"/d/[entity]">;

async function sheetOf(name: string): Promise<Tearsheet> {
  const outcome = await new DesService(desDeps(), { limits: OPEN_LIMITS }).describe(request(name));
  if (outcome.kind !== "ready") throw new Error(`no tearsheet for ${name}: ${outcome.kind}`);
  return outcome.sheet;
}

const SHEET = await sheetOf("Juniper Cola");
const OWN = await sheetOf("Brand Alpha");

async function render(entity: string, search: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await DesPage(props(entity, search)));
}

beforeEach(() => {
  loadTearsheet.mockReset();
  redirect.mockClear();
});

describe("generateMetadata", () => {
  it("indexes a curated entity's tearsheet at its own address, with a description, without waiting for the lookup", async () => {
    // Whatever the lookup would say now (a pause, a limit), the curated page stays in the index.
    loadTearsheet.mockResolvedValue({ kind: "unavailable", cause: "paused", message: "Live tearsheets are paused.", until: null });
    const metadata = await generateMetadata(props("Juniper%20Cola"));
    expect(metadata).toEqual({
      title: "Juniper Cola · DES · Culture Terminal",
      description: expect.stringMatching(/^Juniper Cola: audience DNA, cultural neighbours and travel taste/),
      alternates: { canonical: "/d/Juniper%20Cola" },
    });
    expect((await generateMetadata(props("Comedian%20Vega", { type: "person" }))).title).toBe("Comedian Vega · DES · Culture Terminal");
    expect(loadTearsheet).not.toHaveBeenCalled();
  });

  it("keeps a reader's own lookup out of the index without waiting for it", async () => {
    const metadata = await generateMetadata(props("Brand%20Alpha"));
    expect(metadata).toEqual({ title: "Brand Alpha · DES · Culture Terminal", robots: NOINDEX });
    expect(loadTearsheet).not.toHaveBeenCalled();
  });

  it("keeps a curated name out of the index at any other address: picked, another spelling or type, or a needless ?type=", async () => {
    for (const [entity, search] of [
      ["Juniper%20Cola", { pick: "pk_00000000000000ab" }],
      ["JUNIPER%20COLA", {}],
      ["juniper%20cola", {}],
      ["Juniper%20Cola", { type: "artist" }],
      ["Juniper%20Cola", { type: "brand" }],
    ] as const) {
      expect((await generateMetadata(props(entity, search))).robots).toEqual(NOINDEX);
    }
    expect(await generateMetadata(props("%3Cx%3E"))).toEqual({ title: "Tearsheet · Culture Terminal", robots: NOINDEX });
    expect(loadTearsheet).not.toHaveBeenCalled();
  });

  it("never puts an uncurated person's name in the title", async () => {
    expect(await generateMetadata(props("Neighbour%20Vega", { type: "person" }))).toEqual({ title: "Tearsheet · Culture Terminal", robots: NOINDEX });
    expect(await generateMetadata(props("comedian%20vega", { type: "person", pick: "pk_00000000000000ab" }))).toEqual({
      title: "Tearsheet · Culture Terminal",
      robots: NOINDEX,
    });
  });
});

describe("the tearsheet", () => {
  it("draws the head, the five sections in order, every figure and the receipts", async () => {
    loadTearsheet.mockResolvedValue({ kind: "ready", sheet: SHEET, cachedAt: null });
    const html = await render("Juniper%20Cola");
    expect(html).toMatch(/<h1[^>]*>Juniper Cola<\/h1>/);
    expect(html).toContain("JUNIPER COLA &lt;BRAND&gt; DES");
    expect(html).toContain("Curated");
    expect(html).not.toContain('data-unlisted="true"');
    const sections = [...html.matchAll(/data-section="([a-z]+)"/g)].map((m) => m[1]);
    expect(sections).toEqual(["overview", "dna", "neighbours", "travel", "receipts"]);
    for (const id of sections) expect(html).toContain(`href="#${id}"`);
    // Figures 1 to 7: DNA bars and tags, four domain lists, the travel quadrant.
    expect([...html.matchAll(/data-figure="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(html).toContain('data-kind="Bars"');
    expect(html).toContain('data-kind="Quadrant"');
    expect(html).toContain('data-neighbour-lists="4"');
    expect(html).toContain('data-tag-family="');
    expect((html.match(/data-key-figure="M\d+"/g) ?? []).length).toBe(4);
    // Receipts: one row per request, and each figure's source links to its row.
    expect((html.match(/data-receipt="\d+"/g) ?? []).length).toBe(8);
    expect(html).toContain('href="#receipt-1"');
    expect(html).toContain(`${SHEET.traced.total}/${SHEET.traced.total} numbers traced`);
    expect(html).toContain("Qloo 8 req");
    expect(html).toContain("$0 LLM");
    expect(html).toContain('data-picked="false"');
    expect(html).toContain("The name was matched exactly, name and type");
    // The destination the travel figure's title names is the plot's one ring, and the caption says so.
    const travel = SHEET.sections.travel.figures[0];
    const top = travel?.dataset.kind === "Quadrant" ? travel.dataset.payload.points.find((p) => p.key === travel.featured?.[0]) : undefined;
    if (!top) throw new Error("no featured destination");
    expect(html).toContain(`Its taste travels furthest to ${top.label}`);
    expect(html).toContain(`The ring marks ${top.label}, the closest fit.`);
    expect(html.match(/data-tone="featured"/g)).toHaveLength(1);
    expect(html).toContain(`data-point="${top.key}" data-tone="featured"`);
    // A count or a duration in Receipts never breaks inside.
    expect(html).toMatch(/<span class="whitespace-nowrap">\d+ rows?<\/span>/);
    // The search box, with the tearsheet's type selected.
    expect(html).toContain('action="/d"');
    expect(html).toMatch(/<option value="brand" selected="">Brand<\/option>/);
    expect(html).not.toMatch(/mock-ent-/);
  });

  it("marks a reader's own lookup unlisted and says when a cached tearsheet was computed", async () => {
    loadTearsheet.mockResolvedValue({ kind: "ready", sheet: OWN, cachedAt: "2026-10-23T08:30:00.000Z" });
    const html = await render("Brand%20Alpha");
    expect(html).toContain('data-unlisted="true"');
    expect(html).toContain("Unlisted · reader lookup");
    expect(html).toContain("Served from the tearsheet cache: computed 23 Oct 2026, 08:30 UTC, no request repeated.");
  });

  it("says when the reader picked the entity from Qloo's candidates rather than matching it exactly", async () => {
    loadTearsheet.mockResolvedValue({ kind: "ready", sheet: { ...OWN, picked: true }, cachedAt: null });
    const html = await render("Brand%20Alpha", { pick: "pk_00000000000000ab" });
    expect(html).toContain('data-picked="true"');
    expect(html).toContain("You picked this entity from Qloo&#x27;s candidates; nothing was picked for you.");
    expect(html).not.toContain("matched exactly");
  });
});

describe("the states", () => {
  const candidates = [
    { key: "pk_00000000000000a1", name: "Juniper Twin", disambiguation: "2004", popularity: 0.61, href: "/d/Juniper%20Twin?pick=pk_00000000000000a1" },
    { key: "pk_00000000000000a2", name: "Juniper Twin", disambiguation: null, popularity: null, href: "/d/Juniper%20Twin?pick=pk_00000000000000a2" },
  ];

  it.each<[string, DesOutcome, RegExp[]]>([
    [
      "a picker",
      { kind: "pick", query: { name: "Juniper Twin", type: "brand" }, message: "Pick the one you mean.", candidates },
      [/data-state-card="Pick the one you mean"/, /href="\/d\/Juniper%20Twin\?pick=pk_00000000000000a1"/, /no other detail from Qloo/, /never decides the match/],
    ],
    [
      "a name not found",
      { kind: "not_found", query: { name: "Notfound Cola", type: "brand" }, message: "No exact match.", candidates },
      [/data-state-card="Name not found"/, /No brand in Qloo&#x27;s data is named exactly “Notfound Cola”/, /never applied/],
    ],
    [
      "a pause",
      { kind: "unavailable", cause: "paused", message: "Live tearsheets are paused: it was paused by the operator.", until: null },
      [/data-state-card="Tearsheets unavailable"/, /it was paused by the operator/, /href="\/status"/],
    ],
    [
      "the daily budget",
      { kind: "unavailable", cause: "budget", message: "Today's Qloo requests for tearsheets are used up.", until: null },
      [/Paused · daily budget/],
    ],
    [
      "a rate limit",
      { kind: "limited", message: "Try again in 40 s.", retryAfterS: 40 },
      [/data-state-card="Too many lookups"/, /Try again in 40 s\./, /Try this tearsheet again/],
    ],
    ["a failure", { kind: "failed", message: "The name could not be looked up in Qloo just now." }, [/data-state-card="Lookup failed"/]],
  ])("words %s with the search box under it", async (_name, outcome, patterns) => {
    loadTearsheet.mockResolvedValue(outcome);
    const name = "query" in outcome ? outcome.query.name : "Juniper Cola";
    const html = await render(encodeURIComponent(name), "query" in outcome && outcome.query.type !== "brand" ? { type: outcome.query.type } : {});
    for (const p of patterns) expect(html).toMatch(p);
    expect(html).toMatch(new RegExp(`<h1[^>]*>${name}</h1>`));
    expect(html).toContain('action="/d"');
    expect(html).not.toContain("data-section=");
  });

  it("refuses a person who is not vetted without repeating the name, saying no request was made", async () => {
    loadTearsheet.mockResolvedValue({
      kind: "refused",
      query: { name: "Neighbour Vega", type: "person" },
      message: "This name is not among the vetted public figures, so no Qloo request was made for it.",
    });
    const html = await render("Neighbour%20Vega", { type: "person" });
    expect(html).toContain('data-state-card="Lookup refused"');
    expect(html).toContain("Not looked up · not a vetted public figure");
    expect(html).toContain("no Qloo request was made");
    expect(html).toMatch(/<h1[^>]*>Tearsheet<\/h1>/);
    expect(html).not.toContain("Neighbour Vega");
    expect(html).toContain('action="/d"');
  });

  it("explains an address it cannot read, without a lookup", async () => {
    const html = await render("%3Cscript%3E");
    expect(loadTearsheet).not.toHaveBeenCalled();
    expect(html).toContain("That name cannot be looked up");
    expect(html).toMatch(/<h1[^>]*>Describe any entity<\/h1>/);
  });
});

describe("/d", () => {
  const searchProps = (search: Record<string, string>) => ({ params: Promise.resolve({}), searchParams: Promise.resolve(search) }) as PageProps<"/d">;

  it("opens the tearsheet the search box names, compiling <NAME> DES", async () => {
    await expect(DesSearchPage(searchProps({ q: "Artist Nova <ARTIST> DES", type: "brand" }))).rejects.toThrow("NEXT_REDIRECT /d/Artist%20Nova?type=artist");
    await expect(DesSearchPage(searchProps({ q: "Juniper Cola", type: "brand" }))).rejects.toThrow("NEXT_REDIRECT /d/Juniper%20Cola");
  });

  it("shows the search box, with an error for a name it cannot read", async () => {
    const empty = renderToStaticMarkup(await DesSearchPage(searchProps({})));
    expect(empty).toMatch(/<h1[^>]*>Describe any entity<\/h1>/);
    expect(empty).toContain('role="search"');
    expect(empty).not.toContain('aria-invalid="true"');
    const bad = renderToStaticMarkup(await DesSearchPage(searchProps({ q: "<>" })));
    expect(redirect).not.toHaveBeenCalled();
    expect(bad).toContain('aria-invalid="true"');
    expect(bad).toContain("Type a name with letters or digits");
  });
});
