import { expect, expectAnswer, MAP_SAMPLE, open, shot, test } from "./support";

// The map cards on the synthetic answers (app/dev/brief/job-runs.ts, invented entities): the server paints
// each map's schematic, and the browser mounts the MapLibre WebGL map over it once the card nears the
// viewport, with the city's gazetteer outlines (/api/geo/<metro>) and the OpenFreeMap basemap, which needs
// the internet. The site_selection lift map (Austin) switches its layer; the area maps mount for East
// Nashville (tenant_mix, with the corner pin) and Holly, Austin (area_profile). Every other map city's
// outlines are read over HTTP below: no sample answer draws a third city's map yet.

test("the Austin map card mounts and switches Extra interest / All interest", async ({ page }, testInfo) => {
  // WebGL runs on the CPU here (SwiftShader), and a dev server compiles the map's chunk on first use.
  test.setTimeout(60_000);
  await open(page, MAP_SAMPLE);
  await expectAnswer(page);
  const card = page.locator('[data-map-card="austin"]');
  const map = card.locator('[data-lift-map="austin"]');
  await card.scrollIntoViewIfNeeded();

  await expect(map.locator("canvas.maplibregl-canvas")).toBeAttached({ timeout: 20_000 });
  // Shown once the basemap has loaded; until then the schematic stands in.
  await expect(map.locator('[data-map-loaded="true"]'), "the OpenFreeMap basemap did not load (it needs the internet)").toBeVisible({
    timeout: 40_000,
  });

  await expect(map).toHaveAttribute("data-mode", "LIFT");
  await card.getByRole("button", { name: "Extra interest" }).click();
  await card.getByRole("radiogroup", { name: "Map layer" }).getByRole("radio", { name: /^All interest/ }).click();
  await expect(map).toHaveAttribute("data-mode", "RAW");
  await card.getByRole("button", { name: "All interest" }).click();
  await card.getByRole("radiogroup", { name: "Map layer" }).getByRole("radio", { name: /^Extra interest/ }).click();
  await expect(map).toHaveAttribute("data-mode", "LIFT");

  await shot(card, testInfo, "map-card");
});

const AREA_MAPS = [
  { job: "tenant_mix", metro: "nashville" },
  { job: "area_profile", metro: "austin" },
] as const;
for (const { job, metro } of AREA_MAPS) {
  test(`the ${job} area map mounts over its ${metro} outline`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await open(page, `/dev/brief?job=${job}`);
    await expectAnswer(page);
    const card = page.locator("[data-area-map]").first();
    await card.scrollIntoViewIfNeeded();
    // The static outline draws first from /api/geo/<metro>; "No map for this area" or "Map could not load" fails here.
    await expect(card.locator("[data-area-schematic]")).toBeAttached({ timeout: 20_000 });
    await expect(card.locator("canvas.maplibregl-canvas")).toBeAttached({ timeout: 20_000 });
    await expect(card.locator('[data-map-loaded="true"]'), "the OpenFreeMap basemap did not load (it needs the internet)").toBeVisible({
      timeout: 40_000,
    });
    await shot(card, testInfo, `area-map-${job}`);
  });
}

// Only Austin's lift map has a sample answer (job-runs.ts builds it), so every map city's gazetteer is read
// over HTTP. The metros are MetroId's (@ct/contracts), written out: the specs import no workspace package.
const MAP_CITIES = [
  "nashville",
  "austin",
  "nyc",
  "los_angeles",
  "chicago",
  "miami",
  "san_francisco",
  "seattle",
  "boston",
  "denver",
  "atlanta",
  "houston",
  "dallas",
] as const;
for (const metro of MAP_CITIES) {
  test(`the ${metro} gazetteer serves its outlines`, async ({ request }) => {
    const res = await request.get(`/api/geo/${metro}`);
    expect(res.ok(), `/api/geo/${metro} answered ${res.status()}`).toBe(true);
    const body = (await res.json()) as { type?: unknown; metro?: unknown; features?: unknown[] };
    expect(body.type).toBe("FeatureCollection");
    expect(body.metro).toBe(metro);
    expect(body.features?.length ?? 0).toBeGreaterThan(0);
  });
}
