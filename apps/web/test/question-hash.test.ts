import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ANSWER_VERSION, QUESTION_HASH_PREFIX, questionHash } from "../server/question-hash";

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

  it("keys a follow-up on its parent, and leaves the parent out of a question asked on its own", () => {
    const own = questionHash(Q, undefined, "live");
    // A top-level key: the question, pins and mode with the answer version; the parent never enters it.
    const expected = createHash("sha256").update(JSON.stringify([Q.toLowerCase(), [], "live", { answerVersion: ANSWER_VERSION }])).digest("hex");
    expect(own).toBe(`${QUESTION_HASH_PREFIX}${expected}`);
    expect(questionHash(Q, undefined, "live", null)).toBe(own);
    const child = questionHash(Q, undefined, "live", "run-parent-0001");
    expect(child).not.toBe(own);
    expect(questionHash(Q, undefined, "live", "run-parent-0002")).not.toBe(child);
  });

  it("never matches a brief stored under an older answer version", () => {
    // The key runs stored before ANSWER_VERSION 2 carry: the cache must not serve them any more.
    const v1 = createHash("sha256").update(JSON.stringify([Q.toLowerCase(), [], "live"])).digest("hex");
    expect(questionHash(Q, undefined, "live")).not.toBe(`${QUESTION_HASH_PREFIX}${v1}`);
    // Version 2 briefs predate the supply-label rule (a crowded reading from one venue).
    const v2 = createHash("sha256").update(JSON.stringify([Q.toLowerCase(), [], "live", { answerVersion: 2 }])).digest("hex");
    expect(questionHash(Q, undefined, "live")).not.toBe(`${QUESTION_HASH_PREFIX}${v2}`);
  });
});
