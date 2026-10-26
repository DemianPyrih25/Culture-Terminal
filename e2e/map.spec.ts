import { expect, expectNote, MAP_SAMPLE, open, shot, test } from "./support";

// The LiftMap (kind GeoLift) on the site-selection sample: the server paints its schematic, and the
// browser mounts the MapLibre WebGL map over it once the figure nears the viewport, with the Austin
// gazetteer outlines (/api/geo/austin) and the OpenFreeMap basemap, which needs the internet.

test("the Austin lift map mounts and switches RAW / LIFT", async ({ page }, testInfo) => {
  // WebGL runs on the CPU here (SwiftShader), and a dev server compiles the map's chunk on first use.
  test.setTimeout(60_000);
  await open(page, MAP_SAMPLE);
  await expectNote(page);
  const map = page.locator('[data-lift-map="austin"]');
  await map.scrollIntoViewIfNeeded();

  await expect(map.locator("canvas.maplibregl-canvas")).toBeAttached({ timeout: 20_000 });
  // Shown once the basemap has loaded; until then the schematic stands in.
  await expect(map.locator('[data-map-loaded="true"]'), "the OpenFreeMap basemap did not load (it needs the internet)").toBeVisible({
    timeout: 40_000,
  });

  const layers = map.getByRole("group", { name: /^Map layer:/ });
  await layers.getByRole("button", { name: "RAW" }).click();
  await expect(map).toHaveAttribute("data-mode", "RAW");
  await layers.getByRole("button", { name: "LIFT" }).click();
  await expect(map).toHaveAttribute("data-mode", "LIFT");

  await shot(map, testInfo, "lift-map");
});

// No sample brief has a Nashville lift map (job-runs.ts builds Austin's), so its gazetteer is read over
// HTTP. The metros are MetroId's (@ct/contracts), written out: the specs import no workspace package.
for (const metro of ["austin", "nashville"] as const) {
  test(`the ${metro} gazetteer serves its outlines`, async ({ request }) => {
    const res = await request.get(`/api/geo/${metro}`);
    expect(res.ok(), `/api/geo/${metro} answered ${res.status()}`).toBe(true);
    const body = (await res.json()) as { type?: unknown; metro?: unknown; features?: unknown[] };
    expect(body.type).toBe("FeatureCollection");
    expect(body.metro).toBe(metro);
    expect(body.features?.length ?? 0).toBeGreaterThan(0);
  });
}
