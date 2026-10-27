import { readFileSync } from "node:fs";
import { isDeniedAudience, Pillar } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { AUDIENCE_ALLOWLIST, audienceDenial, audienceFamiliesFor } from "../src/audiences";

const mirror: unknown = JSON.parse(readFileSync(new URL("../../../config/audiences.allow.json", import.meta.url), "utf8"));

describe("audience allowlist", () => {
  it("is mirrored exactly by config/audiences.allow.json", () => {
    expect(mirror).toEqual(AUDIENCE_ALLOWLIST);
  });

  it("covers every desk and never allows a denied family", () => {
    expect(Object.keys(AUDIENCE_ALLOWLIST.desks).sort()).toEqual([...Pillar.options].sort());
    const denied = new Set<string>(AUDIENCE_ALLOWLIST.denied.families);
    for (const families of Object.values(AUDIENCE_ALLOWLIST.desks)) {
      for (const family of families) expect(denied.has(family)).toBe(false);
    }
  });

  it("gives standalone tools the union of the desk families", () => {
    const union = new Set(Object.values(AUDIENCE_ALLOWLIST.desks).flat());
    expect([...audienceFamiliesFor(null)].sort()).toEqual([...union].sort());
  });

  it("allows the six D21 families on every desk", () => {
    const six = ["hobbies_and_interests", "investing_interests", "leisure", "life_stage", "professional_area", "spending_habits"];
    for (const desk of Pillar.options) expect([...audienceFamiliesFor(desk)].sort(), desk).toEqual(six);
  });

  it("explains each denial", () => {
    expect(audienceDenial("urn:audience:leisure:fixture_fans", "marketing")).toBeNull();
    expect(audienceDenial("urn:audience:communities:fixture", "marketing")).toMatch(/D21/);
    expect(audienceDenial("urn:tag:genre:brand:fixture", "marketing")).toMatch(/not an audience URN/);
  });

  it("agrees with contracts isDeniedAudience: denied on every desk, never just off one desk's list", () => {
    const keys = [
      "urn:audience:communities:fixture",
      "urn:audience:global_issues:fixture",
      "urn:audience:leisure:political_junkie",
      "urn:audience:leisure:fixture_fans",
      "urn:audience:investing_interests:fixture",
    ];
    for (const key of keys) {
      const everywhere = Pillar.options.every((desk) => /denied on every desk/.test(audienceDenial(key, desk) ?? ""));
      expect(isDeniedAudience(key), key).toBe(everywhere);
    }
    // Off every desk's list, yet not a sensitive segment.
    expect(audienceDenial("urn:audience:unknown_family:fixture", "location")).toMatch(/not allowed/);
    expect(isDeniedAudience("urn:audience:unknown_family:fixture")).toBe(false);
  });
});
