import { describe, expect, it } from "vitest";
import { choiceOption, intOption, listOption, NAME_MAX, nameArg, parseCli, pinsOption, UsageError } from "./args";

const SPECS = {
  k: { type: "string" },
  discover: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

describe("parseCli", () => {
  it("splits positionals from flags, inline values included", () => {
    const parsed = parseCli(["peer_landscape", "Brand Alpha", "--k=5", "-h"], SPECS);
    expect(parsed.positionals).toEqual(["peer_landscape", "Brand Alpha"]);
    expect(parsed.options).toEqual({ k: "5", help: true });
  });

  it("reads --no-<flag> as false and leaves absent flags undefined", () => {
    expect(parseCli(["--no-discover"], SPECS).options).toEqual({ discover: false });
    expect(parseCli([], SPECS).options.discover).toBeUndefined();
  });

  it("treats everything after -- as positionals", () => {
    expect(parseCli(["--", "--k"], SPECS).positionals).toEqual(["--k"]);
  });

  it("turns unknown flags and missing values into usage errors", () => {
    expect(() => parseCli(["--peers", "A"], SPECS)).toThrow(UsageError);
    expect(() => parseCli(["--k"], SPECS)).toThrow(UsageError);
    expect(() => parseCli(["--discover=yes"], SPECS)).toThrow(UsageError);
  });
});

describe("intOption", () => {
  const range = { min: 4, max: 7, fallback: 6 };

  it("falls back when absent and accepts integers in range", () => {
    expect(intOption(undefined, "--k", range)).toBe(6);
    expect(intOption("4", "--k", range)).toBe(4);
    expect(intOption(" 7 ", "--k", range)).toBe(7);
  });

  it.each(["3", "8", "5.5", "", "five"])("rejects %j", (raw) => {
    expect(() => intOption(raw, "--k", range)).toThrow(/--k must be an integer from 4 to 7/);
  });
});

describe("listOption", () => {
  it("trims, drops empty items and keeps each normalised name once", () => {
    expect(listOption(" Brand Beta, ,Brand Gamma,brand beta ,BRAND GAMMA")).toEqual(["Brand Beta", "Brand Gamma"]);
    expect(listOption(undefined)).toEqual([]);
  });
});

describe("pinsOption", () => {
  it("keys pins by the normalised mention text, as runAgent looks them up", () => {
    expect(pinsOption("The Brand Alpha=ent-alpha-1, Snack Omega Inc.=ent-omega-2")).toEqual({
      "brand alpha": "ent-alpha-1",
      "snack omega": "ent-omega-2",
    });
  });

  it("keeps everything after the first = as the id", () => {
    expect(pinsOption("Brand Alpha=ent=1")).toEqual({ "brand alpha": "ent=1" });
  });

  it("accepts a repeated pin with the same id and refuses conflicting ones", () => {
    expect(pinsOption("Brand Alpha=ent-1,brand alpha=ent-1")).toEqual({ "brand alpha": "ent-1" });
    expect(() => pinsOption("Brand Alpha=ent-1,brand alpha=ent-2")).toThrow(/twice/);
  });

  it.each(["Brand Alpha", "=ent-1", "Brand Alpha="])("refuses the malformed pin %j", (raw) => {
    expect(() => pinsOption(raw)).toThrow(UsageError);
  });
});

describe("nameArg", () => {
  it("trims a name and takes it up to resolve_entities' limit", () => {
    expect(NAME_MAX).toBe(80);
    expect(nameArg("  Brand Alpha ", "a name")).toBe("Brand Alpha");
    expect(nameArg("A".repeat(80), "a name")).toHaveLength(80);
  });

  it("refuses an empty name and one longer than the contract allows", () => {
    expect(() => nameArg("   ", "a name")).toThrow(new UsageError("a name must not be empty"));
    expect(() => nameArg("A".repeat(81), "a --peers name")).toThrow(new UsageError("a --peers name is 81 characters; resolve_entities takes at most 80"));
  });
});

describe("choiceOption", () => {
  it("falls back when absent and refuses values outside the set", () => {
    expect(choiceOption(undefined, "--lane", ["public", "judge"], "public")).toBe("public");
    expect(choiceOption("judge", "--lane", ["public", "judge"], "public")).toBe("judge");
    expect(() => choiceOption("vip", "--lane", ["public", "judge"], "public")).toThrow(/--lane must be one of public, judge/);
  });
});
