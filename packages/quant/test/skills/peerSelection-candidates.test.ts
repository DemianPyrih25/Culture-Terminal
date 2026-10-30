// R3 (D49): named brands first, then expected ones, with two slots left for discovery.
import type { RegisteredEntity } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { withCandidatePeers } from "../../src/skills/peerLandscape";
import { FakeRegistry, registerInvented } from "./support/fakes";

describe("peer rule with candidates", () => {
  it("adds named brands, then at most min(3, open − 2) expected ones, never the target or a duplicate", () => {
    const r = new FakeRegistry();
    const target = registerInvented(r, { id: "ent-target", name: "Brand Target", category: null });
    const named = registerInvented(r, { id: "ent-named", name: "Brand Named", category: null });
    const obvious = Array.from({ length: 5 }, (_, i) => registerInvented(r, { id: `ent-obv-${i}`, name: `Brand Obvious ${i}`, category: null }));
    const candidates = {
      entities: [
        { ref: named.ref, source: "user_named" as const },
        { ref: target.ref, source: "obvious" as const },
        ...obvious.map((e) => ({ ref: e.ref, source: "obvious" as const })),
      ],
      areas: [],
      markets: [],
    };
    const out = withCandidatePeers({ peers: [], notices: [] }, { k: 8, discover: true }, { candidates, registry: r }, target as RegisteredEntity);
    // 7 slots: 1 named, then min(3, 7 − 1 − 2) = 3 expected.
    expect(out.peers.map((p) => p.name)).toEqual(["Brand Named", "Brand Obvious 0", "Brand Obvious 1", "Brand Obvious 2"]);
    const small = withCandidatePeers({ peers: [], notices: [] }, { k: 4, discover: true }, { candidates, registry: r }, target as RegisteredEntity);
    // 3 slots: 1 named, then min(3, 3 − 1 − 2) = 0 expected.
    expect(small.peers.map((p) => p.name)).toEqual(["Brand Named"]);
    const off = withCandidatePeers({ peers: [], notices: [] }, { k: 8, discover: false }, { candidates, registry: r }, target as RegisteredEntity);
    expect(off.peers).toEqual([]);
  });
});
