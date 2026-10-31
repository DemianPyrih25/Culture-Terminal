// /d/[entity] and /d rendered on the server: noindex unless a curated entity's profile is drawn (D31),
// the profile's header, key numbers and cards (N14), each state's card, and the search box. The lookup is
// stubbed where the page loads it; the tearsheet itself comes from the service on the Qloo mock. Invented
// entities only (D29).
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesType } from "../../components/des/des-href";
import type { DesOutcome, Tearsheet } from "../../components/des/model";
import { decode } from "../figures/markup";
import { desDeps, OPEN_LIMITS, request } from "./support";

const { loadTearsheet, redirect } = vi.hoisted(() => ({
  loadTearsheet: vi.fn<(name: string, type: DesType, pick: string | null) => Promise<DesOutcome>>(),
  redirect: vi.fn((href: string) => {
    throw new Error(`NEXT_REDIRECT ${href}`);
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), redirect }));
vi.mock("../../app/d/[entity]/load", () => ({ loadTearsheet }));
// Juniper Cola (a brand) and Comedian Vega (a person) stand for curated entities, as the config spells
// them; every other name is a reader's own lookup.
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
const { default: DesLoading } = await import("../../app/d/[entity]/loading");
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
  it("indexes a curated entity's profile at its own address, with a description, without waiting for the lookup", async () => {
    // Whatever the lookup would say now (a pause, a limit), the curated page stays in the index.
    loadTearsheet.mockResolvedValue({ kind: "unavailable", cause: "paused", message: "Live profiles are paused.", until: null });
    const metadata = await generateMetadata(props("Juniper%20Cola"));
    expect(metadata).toEqual({
      title: "Juniper Cola · Audience profile · Culture Terminal",
      description: "Juniper Cola: who its fans are, what else they love, and where their taste travels. From Qloo taste data, every number traced.",
      alternates: { canonical: "/d/Juniper%20Cola" },
    });
    expect((await generateMetadata(props("Comedian%20Vega", { type: "person" }))).title).toBe("Comedian Vega · Audience profile · Culture Terminal");
    expect(loadTearsheet).not.toHaveBeenCalled();
  });

  it("keeps a reader's own lookup out of the index without waiting for it", async () => {
    const metadata = await generateMetadata(props("Brand%20Alpha"));
    expect(metadata).toEqual({ title: "Brand Alpha · Audience profile · Culture Terminal", robots: NOINDEX });
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
    expect(await generateMetadata(props("%3Cx%3E"))).toEqual({ title: "Profile · Culture Terminal", robots: NOINDEX });
    expect(loadTearsheet).not.toHaveBeenCalled();
  });

  it("never puts an uncurated person's name in the title", async () => {
    expect(await generateMetadata(props("Neighbour%20Vega", { type: "person" }))).toEqual({ title: "Profile · Culture Terminal", robots: NOINDEX });
    expect(await generateMetadata(props("comedian%20vega", { type: "person", pick: "pk_00000000000000ab" }))).toEqual({
      title: "Profile · Culture Terminal",
      robots: NOINDEX,
    });
  });
});

describe("the profile", () => {
  it("draws the entity header, the three key numbers and the four cards in the new shell", async () => {
    loadTearsheet.mockResolvedValue({ kind: "ready", sheet: SHEET, cachedAt: null });
    const html = await render("Juniper%20Cola");
    const text = decode(html);
    expect(html.match(/<h1[^>]*>/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>Juniper Cola<\/h1>/);
    expect(text).toMatch(/Brand · Audience profile · Data as of \d{1,2} [A-Z][a-z]{2} \d{4}/);
    expect(html).toContain('href="/ask?q=Who%20is%20the%20Juniper%20Cola%20audience%3F"');
    for (const action of ["Ask about Juniper Cola", "Look up another", "Follow", "How we know"]) expect(text).toContain(action);
    // A brand profile can be followed (§2.4): re-run later as a brand-health note.
    expect(html).toContain('data-follow="brand"');
    // Key numbers, from the tearsheet's popularity, youth and gender figures.
    for (const label of ["How widely known", "Age lean", "Gender lean"]) expect(html).toContain(`aria-label="${label}"`);
    expect(text).toContain("Top 22%");
    expect(text).toContain("among all brands in Qloo");
    expect(text).toContain("Leans younger");
    expect(text).toContain("+0.59 vs the average audience");
    expect(text).toContain("Leans female");
    expect(text).toContain("+0.11 for women vs the average audience");
    // The cards, each titled from its data.
    for (const kind of ["Who the fans are", "How Qloo describes it", "What else their fans love", "Places their fans travel to"]) {
      expect(text).toContain(kind);
    }
    expect(text).toContain("Fans lean female and 30–44.");
    expect(text).toContain("Relative to the average audience, not shares of customers.");
    expect(text).toContain("Bold, earnest and busy parent.");
    expect(html).toMatch(/data-tag-family="Look"[\s\S]*data-tag-family="Tone"[\s\S]*data-tag-family="Lifestyle"/);
    expect(text).toContain("Qloo's taste tags for the brand, grouped by theme.");
    expect(html.match(/data-domain="/g)).toHaveLength(4);
    expect(html).toContain('href="/d/Lyric%20and%20the%20Tides?type=artist"');
    expect(text).toMatch(/Fans also love [^.]+, [^.]+ and [^.]+\./);
    const travel = SHEET.sections.travel.figures[0];
    const top = travel?.dataset.kind === "Quadrant" ? [...travel.dataset.payload.points].sort((a, b) => b.y - a.y)[0] : undefined;
    if (!top) throw new Error("no destination");
    expect(text).toContain(`Their taste travels furthest to ${top.label}.`);
    expect(text).toContain("Places their fans are drawn to, not where they live.");
    // The travel bars are one image to assistive tech; the list inside is hidden (an <ol> cannot take role img).
    expect(html).toMatch(/<div role="img" aria-label="[^"]+" data-plot="travel"><ol aria-hidden="true"/);
    expect(html).not.toMatch(/<ol[^>]*role="img"/);
    expect((html.match(/aria-label="Source of /g) ?? []).length).toBeGreaterThanOrEqual(7);
    // The drawer is closed: no request id or Qloo id reaches the page.
    expect(html).not.toMatch(/mock-[0-9a-f]{6,}|mock-ent-|urn:/);
    expect(html).not.toContain('role="dialog"');
    // The new design only, and no examples.
    expect(html).toContain('data-header="inner"');
    expect(html).not.toMatch(/font-serif|text-dim|text-faint|rounded-brief|bg-paper|Receipts|Tearsheet/);
    expect(text).not.toMatch(/example|showcase/i);
  });

  it("says when Qloo spells the name differently from the address, and dates a cached profile", async () => {
    loadTearsheet.mockResolvedValue({ kind: "ready", sheet: { ...OWN, query: { ...OWN.query, name: "brand alfa" } }, cachedAt: "2026-10-23T08:30:00.000Z" });
    const text = decode(await render("brand%20alfa"));
    expect(text).toContain("Looked up as “brand alfa”.");
    expect(text).toContain("Data as of 23 Oct 2026");
  });
});

describe("the states", () => {
  const candidates = [
    { key: "pk_00000000000000a1", name: "Juniper Twin", disambiguation: "2004", popularity: 0.61, href: "/d/Juniper%20Twin?pick=pk_00000000000000a1" },
    { key: "pk_00000000000000a2", name: "Juniper Twin", disambiguation: null, popularity: 0.2, href: "/d/Juniper%20Twin?pick=pk_00000000000000a2" },
  ];

  it.each<[string, DesOutcome, RegExp[]]>([
    [
      "a picker",
      { kind: "pick", query: { name: "Juniper Twin", type: "brand" }, message: "Pick the one you mean.", candidates },
      [
        /data-state-card="Which one"/,
        /“Juniper Twin” could mean a few things\. Which one\?/,
        /href="\/d\/Juniper%20Twin\?pick=pk_00000000000000a1"/,
        /No other detail from Qloo/,
        /Widely known/,
        /Less known/,
        /Not listed\?/,
      ],
    ],
    [
      "a name not found",
      { kind: "not_found", query: { name: "Notfound Cola", type: "brand" }, message: "No exact match.", candidates },
      [/data-state-card="Name not found"/, /“Notfound Cola” isn&#x27;t in Qloo&#x27;s data\./, /Check the spelling or use the full name/, /Closest names in Qloo/],
    ],
    [
      "a pause",
      { kind: "unavailable", cause: "paused", message: "Live profiles are paused: it was paused by the operator.", until: null },
      [/data-state-card="Paused"/, /it was paused by the operator/],
    ],
    [
      "a rate limit",
      { kind: "limited", message: "Try again in 40 s.", retryAfterS: 40 },
      [/data-state-card="Too many lookups"/, /Try again in 40 s\./, /href="\/d\/Juniper%20Cola"[^>]*>[\s\S]*?Try again/],
    ],
    [
      "a failure",
      { kind: "failed", message: "The name could not be looked up in Qloo just now." },
      [/data-state-card="Not finished"/, /This profile couldn&#x27;t be finished\./, /Try again/],
    ],
  ])("words %s with the search box under it", async (_name, outcome, patterns) => {
    loadTearsheet.mockResolvedValue(outcome);
    const name = "query" in outcome ? outcome.query.name : "Juniper Cola";
    const html = await render(encodeURIComponent(name), "query" in outcome && outcome.query.type !== "brand" ? { type: outcome.query.type } : {});
    for (const p of patterns) expect(html).toMatch(p);
    expect(html).toMatch(new RegExp(`<h1[^>]*>${name}</h1>`));
    expect(html).toContain('action="/d"');
    expect(html).toContain('id="look-up"');
    expect(html).not.toContain("data-profile=");
  });

  it("refuses a person who is not vetted without repeating the name", async () => {
    loadTearsheet.mockResolvedValue({
      kind: "refused",
      query: { name: "Neighbour Vega", type: "person" },
      message: "This name is not among the vetted public figures, so no Qloo request was made for it.",
    });
    const html = await render("Neighbour%20Vega", { type: "person" });
    expect(html).toContain('data-state-card="Not looked up"');
    expect(html).toContain("We only profile public figures.");
    expect(html).toContain("no Qloo request was made");
    expect(html).toMatch(/<h1[^>]*>Look up a profile<\/h1>/);
    expect(html).not.toContain("Neighbour Vega");
    expect(html).toContain('action="/d"');
  });

  it("explains an address it cannot read, without a lookup", async () => {
    const html = await render("%3Cscript%3E");
    expect(loadTearsheet).not.toHaveBeenCalled();
    expect(decode(html)).toContain("That name can't be looked up");
    expect(html).toMatch(/<h1[^>]*>Look up a profile<\/h1>/);
  });
});

describe("/d/[entity] while loading", () => {
  it("keeps one page heading for screen readers under the skeleton", () => {
    const html = renderToStaticMarkup(<DesLoading />);
    expect(html.match(/<h1[^>]*>/g)).toHaveLength(1);
    expect(html).toMatch(/<h1 class="sr-only">Loading the profile…<\/h1>/);
  });
});

describe("/d", () => {
  const searchProps = (search: Record<string, string>) => ({ params: Promise.resolve({}), searchParams: Promise.resolve(search) }) as PageProps<"/d">;

  it("opens the profile the search box names, compiling <NAME> DES", async () => {
    await expect(DesSearchPage(searchProps({ q: "Artist Nova <ARTIST> DES", type: "brand" }))).rejects.toThrow("NEXT_REDIRECT /d/Artist%20Nova?type=artist");
    await expect(DesSearchPage(searchProps({ q: "Juniper Cola", type: "brand" }))).rejects.toThrow("NEXT_REDIRECT /d/Juniper%20Cola");
  });

  it("shows the search box, with an error for a name it cannot read", async () => {
    const empty = renderToStaticMarkup(await DesSearchPage(searchProps({})));
    expect(empty).toMatch(/<h1[^>]*>Look up a profile<\/h1>/);
    // The card under the page heading does not repeat it.
    expect(empty.match(/>Look up a profile</g)).toHaveLength(1);
    expect(empty).toMatch(/<h2[^>]*>Name and type<\/h2>/);
    expect(empty).toContain('role="search"');
    expect(empty).toMatch(/<option value="brand" selected="">Brand<\/option>/);
    expect(empty).not.toContain('aria-invalid="true"');
    const bad = renderToStaticMarkup(await DesSearchPage(searchProps({ q: "<>" })));
    expect(redirect).not.toHaveBeenCalled();
    expect(bad).toContain('aria-invalid="true"');
    expect(bad).toContain("Type a name with letters or digits");
  });
});
