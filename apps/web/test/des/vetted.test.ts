// The $0 public-figure check: names CLERK marked public figures, compared as the gate compares names,
// read at most once a minute, and nobody vetted when they cannot be read. Invented names only (D29).
import { describe, expect, it, vi } from "vitest";
import { clock } from "./support";

vi.mock("server-only", () => ({}));

const { VETTED_TTL_MS, vettedPersonFrom } = await import("../../server/des/vetted");

describe("vettedPersonFrom", () => {
  it("vets a name CLERK marked a public figure, as the gate compares names, and nobody else", async () => {
    const vetted = vettedPersonFrom(async () => ["Comedian Nova", "  "]);
    expect(await vetted("comedian   NOVA")).toBe(true);
    expect(await vetted("Comedian Nova!")).toBe(true);
    expect(await vetted("Neighbour Vega")).toBe(false);
    expect(await vetted("")).toBe(false);
  });

  it("reads the names once per minute, once for lookups that arrive together", async () => {
    const c = clock();
    const names = vi.fn(async () => ["Comedian Nova"]);
    const vetted = vettedPersonFrom(names, { now: c.now });
    await Promise.all([vetted("Comedian Nova"), vetted("Neighbour Vega")]);
    c.ms += VETTED_TTL_MS - 1;
    await vetted("Comedian Nova");
    expect(names).toHaveBeenCalledTimes(1);
    c.ms += 1;
    await vetted("Comedian Nova");
    expect(names).toHaveBeenCalledTimes(2);
  });

  it("vets nobody when the names cannot be read, and reads again after a minute", async () => {
    const c = clock();
    const names = vi.fn<() => Promise<string[]>>().mockRejectedValueOnce(new Error("database down")).mockResolvedValue(["Comedian Nova"]);
    const vetted = vettedPersonFrom(names, { now: c.now });
    expect(await vetted("Comedian Nova")).toBe(false);
    c.ms += VETTED_TTL_MS;
    expect(await vetted("Comedian Nova")).toBe(true);
  });
});
