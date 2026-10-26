import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { QUESTION_HASH_PREFIX, questionHash } from "../server/question-hash";

vi.mock("server-only", () => ({}));

const Q = "Is the Juniper Cola audience a moat or a niche?";

describe("questionHash (the D26 answer-cache key)", () => {
  it("is a prefixed sha256 hex digest", () => {
    expect(questionHash(Q, undefined, "live")).toMatch(new RegExp(`^${QUESTION_HASH_PREFIX}[0-9a-f]{64}$`));
  });

  it("ignores case, spacing and invisible characters in the question", () => {
    const base = questionHash(Q, undefined, "live");
    expect(questionHash(`  ${Q.toUpperCase()}\n`, undefined, "live")).toBe(base);
    expect(questionHash(Q.replace(/ /g, "  \t"), undefined, "live")).toBe(base);
    expect(questionHash(`Is the Juniper\u200B Cola audience a moat or a niche?`, undefined, "live")).toBe(base);
    expect(questionHash(`${Q} Really?`, undefined, "live")).not.toBe(base);
  });

  it("keys on the pins, whatever their order, and on the mode", () => {
    const pins = { "juniper cola": "entity-alpha", "kestrel tonic": "entity-beta" };
    const reversed = { "kestrel tonic": "entity-beta", "juniper cola": "entity-alpha" };
    expect(questionHash(Q, pins, "live")).toBe(questionHash(Q, reversed, "live"));
    expect(questionHash(Q, pins, "live")).not.toBe(questionHash(Q, undefined, "live"));
    expect(questionHash(Q, {}, "live")).toBe(questionHash(Q, undefined, "live"));
    expect(questionHash(Q, undefined, "economy")).not.toBe(questionHash(Q, undefined, "live"));
  });

  it("keys a follow-up on its parent, and leaves a question asked on its own keyed as before", () => {
    const own = questionHash(Q, undefined, "live");
    // The key every stored top-level run already has: the parent never enters it.
    const before = createHash("sha256").update(JSON.stringify([Q.toLowerCase(), [], "live"])).digest("hex");
    expect(own).toBe(`${QUESTION_HASH_PREFIX}${before}`);
    expect(questionHash(Q, undefined, "live", null)).toBe(own);
    const child = questionHash(Q, undefined, "live", "run-parent-0001");
    expect(child).not.toBe(own);
    expect(questionHash(Q, undefined, "live", "run-parent-0002")).not.toBe(child);
  });
});
