import { ProvenanceRequest } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical";
import { curlFor, provenanceRequest } from "../src/provenance";

describe("provenance", () => {
  const request = canonicalize("/v2/insights", {
    "filter.type": "urn:entity:brand",
    "signal.interests.entities": ["ent-beta-02", "ent-alpha-01"],
    "signal.location.query": "Fixture's Town",
  });

  it("builds the kit envelope entry from the canonical query", () => {
    const req = provenanceRequest({ path: request.path, query: request.query });
    expect(ProvenanceRequest.parse(req)).toEqual({
      method: "GET",
      path: "/v2/insights",
      query: {
        "filter.type": "urn:entity:brand",
        "signal.interests.entities": "ent-alpha-01,ent-beta-02",
        "signal.location.query": "Fixture's Town",
      },
    });
  });

  it("copies as curl with the key placeholder and safe quoting", () => {
    const curl = curlFor(provenanceRequest(request), "https://hackathon.api.qloo.com/");
    expect(curl).toBe(
      `curl -sS 'https://hackathon.api.qloo.com/v2/insights?${request.qs.replace("'", "'\\''")}' -H "X-Api-Key: $QLOO_API_KEY" -H 'Accept: application/json'`,
    );
    expect(curl).toContain("$QLOO_API_KEY");
    expect(curl).toContain("Fixture'\\''s");
  });
});
