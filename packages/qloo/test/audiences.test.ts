import { readFileSync } from "node:fs";
import { Pillar } from "@ct/contracts";
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
    expect([...audienceFamiliesFor("location")].sort()).toEqual(["hobbies_and_interests", "leisure"]);
  });

  it("explains each denial", () => {
    expect(audienceDenial("urn:audience:leisure:fixture_fans", "marketing")).toBeNull();
    expect(audienceDenial("urn:audience:communities:fixture", "marketing")).toMatch(/D21/);
    expect(audienceDenial("urn:tag:genre:brand:fixture", "marketing")).toMatch(/not an audience URN/);
  });
});
