// The answer page with every Part 11 card, from the "part11" variant of the synthetic job runs (invented
// entities, places and links): the popular and hidden areas under the map (R7), the OpenStreetMap supply
// table with its credit (R6), the map's OpenStreetMap layer toggle, and the two context cards (R4, R5).
import { describe, expect, it, vi } from "vitest";
import { HIDDEN_AREAS_LABEL, POPULAR_AREAS_LABEL, RunEvent } from "@ct/contracts";
import { jobRunEvents } from "../../app/dev/brief/job-runs";
import { variantEvents } from "../../app/dev/brief/variants";
import { render, text } from "../brief-page/support";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), usePathname: () => "/r/x" }));

describe("the part11 variant", () => {
  const events = variantEvents(jobRunEvents("site_selection"), "part11");

  it("keeps every event valid, in sequence", () => {
    expect(() => RunEvent.array().parse(events)).not.toThrow();
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.some((e) => e.type === "context.ai")).toBe(true);
    expect(events.some((e) => e.type === "dataset.ready" && e.kind === "Supply")).toBe(true);
  });

  it("draws the standing card, the supply table and the context row on a site answer", () => {
    const { html } = render(events);
    const page = text(html);
    expect(html).toContain("data-standing=");
    expect(page).toContain(POPULAR_AREAS_LABEL);
    expect(page).toContain(HIDDEN_AREAS_LABEL);
    expect(html).toContain('data-supply-scope="areas"');
    expect(page).toContain("© OpenStreetMap contributors (ODbL)");
    expect(page).toContain("counts are a floor, not a census");
    expect(html).toContain('data-context-row="ai+web"');
    // Neither the supply read nor the context blocks are listed again under More charts.
    expect(html).not.toMatch(/data-more-chart="[^"]*"[^>]*>[^<]*Places already there/);
  });

  it("offers the OpenStreetMap layer on the map card", () => {
    const { html } = render(events);
    expect(html).toContain("Similar places (OpenStreetMap)");
  });
});
