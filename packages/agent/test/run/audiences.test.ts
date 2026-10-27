// The run's AUDIENCES (D21): the pinned catalogue read at run start, the desk filter, the block the
// ANALYST reads and the audiences a tool call sends. Invented segments only (D29).
import type { AudienceCatalogueRead } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { audienceSegmentsFor, audiencesBlock, callAudiences, loadRunAudiences, unlistedAudiences } from "../../src/run/audiences";

const SEGMENTS = [
  { key: "urn:audience:hobbies_and_interests:synthetic_climbers", label: "Climbers" },
  { key: "urn:audience:investing_interests:synthetic_angels", label: "Angel and start-up investing" },
  { key: "urn:audience:communities:synthetic_group", label: "Denied family" },
  { key: "urn:audience:leisure:political_junkie", label: "Denied segment" },
  { key: "urn:audience:hobbies_and_interests:synthetic_climbers", label: "Repeated" },
];

const catalogue = (read: AudienceCatalogueRead) => ({ audienceCatalogue: async () => read });

describe("run audiences", () => {
  it("keeps the segments D21 allows on the desk, each once, in catalogue order", () => {
    const keys = audienceSegmentsFor("location", SEGMENTS).map((s) => s.key);
    expect(keys).toEqual(["urn:audience:hobbies_and_interests:synthetic_climbers", "urn:audience:investing_interests:synthetic_angels"]);
    expect(audienceSegmentsFor("marketing", SEGMENTS).map((s) => s.key)).toEqual(keys);
  });

  it("loads the pinned catalogue once for the run and offers nothing when it is missing, malformed or unreadable", async () => {
    const pinned = await loadRunAudiences(catalogue({ state: "pinned", segments: SEGMENTS, fetchedAt: "2026-10-27T03:00:00.000Z" }), "audience");
    expect(pinned.state).toBe("pinned");
    expect([...pinned.keys]).toEqual(pinned.segments.map((s) => s.key));
    expect(pinned.segments).toHaveLength(2);

    const malformed = await loadRunAudiences(catalogue({ state: "malformed", segments: [], fetchedAt: null }), "audience");
    expect(malformed).toMatchObject({ state: "malformed", segments: [] });
    expect(await loadRunAudiences({}, "audience")).toMatchObject({ state: "missing", segments: [] });
    const failing = { audienceCatalogue: async (): Promise<AudienceCatalogueRead> => Promise.reject(new Error("kv down")) };
    expect(await loadRunAudiences(failing, "audience")).toMatchObject({ state: "failed", segments: [] });
  });

  it("writes one line per family, with a label only where it says more than the key", () => {
    const block = audiencesBlock(audienceSegmentsFor("investment", SEGMENTS), "none in this build");
    expect(block).toBe(
      "AUDIENCES (send only these keys):\n" +
        "- hobbies_and_interests: urn:audience:hobbies_and_interests:synthetic_climbers (Climbers)\n" +
        "- investing_interests: urn:audience:investing_interests:synthetic_angels (Angel and start-up investing)",
    );
    const plain = audiencesBlock([{ key: "urn:audience:leisure:coffee_lovers", label: "Coffee Lovers" }], "none");
    expect(plain).toBe("AUDIENCES (send only these keys):\n- leisure: urn:audience:leisure:coffee_lovers");
    expect(audiencesBlock([], "none in this build")).toBe("AUDIENCES: none in this build");
  });

  it("finds the audiences of share_of_taste and of rank_candidates audience contexts", () => {
    const share = { tool: "share_of_taste" as const, input: { audiences: ["urn:audience:leisure:a", "urn:audience:leisure:b"] } };
    const rank = {
      tool: "rank_candidates" as const,
      input: { contexts: [{ kind: "age", age: "35_and_younger" }, { kind: "audience", audience: "urn:audience:leisure:b" }] },
    };
    expect(callAudiences(share)).toEqual(["urn:audience:leisure:a", "urn:audience:leisure:b"]);
    expect(callAudiences(rank)).toEqual(["urn:audience:leisure:b"]);
    expect(callAudiences({ tool: "audience_dna", input: {} })).toEqual([]);
    expect(unlistedAudiences(share, new Set(["urn:audience:leisure:b"]))).toEqual(["urn:audience:leisure:a"]);
  });
});
