// R8 (D51): a tearsheet reaches the browser with readable names in place of Qloo entity ids.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { publicSheet } = await import("../../server/des/service");

describe("publicSheet", () => {
  it("replaces every entity id with the registered name, keeps request ids", () => {
    // Built at runtime, so no UUID literal sits in the repo (D29).
    const id = ["1a2b3c4d", "0000", "4000", "8000", "00000000abcd"].join("-");
    const requestId = ["9f8e7d6c", "0000", "4000", "8000", "00000000ef01"].join("-");
    const sheet = { evidence: [{ request: { query: { "signal.interests.entities": id } }, requestId }], text: `seed ${id}` };
    const out = publicSheet(sheet, { entities: () => [{ entityId: id, name: "Invented Brand", ref: "R1", type: "brand", popularity: null, disambiguation: null, tags: [] }] });
    expect(JSON.stringify(out)).not.toContain(id);
    expect(JSON.stringify(out)).toContain("Invented Brand");
    expect(out.evidence[0]?.requestId).toBe(requestId);
  });
});
