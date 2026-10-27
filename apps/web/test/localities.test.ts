// The market locality pins in kv (server/localities.ts): how far they cover the markets every run
// needs, what one run's lookups resolve, and that a missing, partial or malformed value is said in the
// logs by market id and count, never with a locality id. kv answers from memory here; no database.
// Invented locality ids only (D29).
import { METRO_LABEL, MetroId } from "@ct/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const kv = vi.hoisted(() => ({ key: "metro_localities", value: undefined as unknown, reads: 0, fail: false }));

vi.mock("@ct/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ct/db")>()),
  getKv: vi.fn(async (_db: unknown, key: string) => {
    if (key !== kv.key) throw new Error(`unexpected kv key ${key}`);
    kv.reads += 1;
    if (kv.fail) throw new Error("kv is unreadable");
    return kv.value;
  }),
}));

const {
  kvLocalities,
  LOCALITIES_KV_KEY,
  localitiesKvKey,
  localityCoverage,
  MOCK_LOCALITIES_KV_KEY,
  readLocalityCoverage,
  REQUIRED_LOCALITY_MARKETS,
} = await import("../server/localities");
const { log } = await import("../server/log");

const db = {} as Parameters<typeof kvLocalities>[0];
/** The 13 map cities, every run's required markets (D28). */
const REQUIRED: readonly string[] = MetroId.options;
/** An invented pin for each map city. */
const MAP_CITY_PINS = Object.fromEntries(
  MetroId.options.map((id, i) => [id, { entityId: `invented-locality-${String(i + 1).padStart(4, "0")}`, label: METRO_LABEL[id] }]),
);
const NASHVILLE = MAP_CITY_PINS.nashville;
const AUSTIN = MAP_CITY_PINS.austin;
/** A market that is no map city. */
const PORTLAND = { entityId: "invented-locality-0101", label: "Portland" };
/** The required markets other than these. */
const missingBut = (...pinned: string[]): string[] => REQUIRED.filter((id) => !pinned.includes(id));
/** How a log line lists the missing markets. */
const missingJson = (ids: readonly string[]): string => `"missing":${JSON.stringify(ids)}`;

/** Every log line written through `level`, as JSON, so a test can look for an id anywhere in it. */
function logged(level: "warn" | "error"): string[] {
  return vi.mocked(log[level]).mock.calls.map((call) => JSON.stringify(call));
}

beforeEach(() => {
  kv.key = "metro_localities";
  kv.value = undefined;
  kv.reads = 0;
  kv.fail = false;
  // Live Qloo data unless a test says otherwise, whatever the shell exports (the dev server sets QLOO_MOCK=1).
  vi.stubEnv("QLOO_MOCK", "");
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  return () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  };
});

describe("localityCoverage", () => {
  it("needs the 13 map cities, the gazetteer metros the run's MARKETS list names", () => {
    expect(LOCALITIES_KV_KEY).toBe("metro_localities");
    expect(REQUIRED_LOCALITY_MARKETS).toEqual(REQUIRED);
    expect(REQUIRED).toHaveLength(13);
  });

  it("is complete with every required market pinned, and counts the other markets too", () => {
    expect(localityCoverage({ ...MAP_CITY_PINS, portland: PORTLAND })).toEqual({
      state: "complete",
      required: REQUIRED,
      missing: [],
      pinned: 14,
    });
  });

  it("is partial with a required market unpinned, and names it", () => {
    expect(localityCoverage({ nashville: NASHVILLE, portland: PORTLAND })).toEqual({
      state: "partial",
      required: REQUIRED,
      missing: missingBut("nashville"),
      pinned: 2,
    });
    expect(localityCoverage({}).state).toBe("partial");
    expect(localityCoverage({}).missing).toEqual(REQUIRED);
  });

  it("is missing without a value and malformed with one that does not parse", () => {
    expect(localityCoverage(undefined)).toEqual({ state: "missing", required: REQUIRED, missing: REQUIRED, pinned: 0 });
    for (const bad of [null, "nashville", [NASHVILLE], { nashville: { entityId: "" , label: "Nashville" } }, { nashville: { ...NASHVILLE, extra: 1 } }, { "Not An Id": NASHVILLE }]) {
      expect(localityCoverage(bad)).toMatchObject({ state: "malformed", missing: REQUIRED, pinned: 0 });
    }
  });

  it("never holds a locality id", () => {
    const coverage = localityCoverage({ nashville: NASHVILLE, portland: PORTLAND });
    expect(JSON.stringify(coverage)).not.toContain("invented-locality");
  });

  it("reads kv for /status, and rejects when kv cannot be read", async () => {
    kv.value = { nashville: NASHVILLE };
    expect(await readLocalityCoverage(db)).toMatchObject({ state: "partial", missing: missingBut("nashville") });
    kv.fail = true;
    await expect(readLocalityCoverage(db)).rejects.toThrow("kv is unreadable");
  });
});

describe("kvLocalities", () => {
  it("reads kv once per run and resolves each market's pin, logging nothing when complete", async () => {
    kv.value = MAP_CITY_PINS;
    const api = kvLocalities(db, { runId: "run-invented-0001" });
    expect(await api.market("nashville")).toEqual(NASHVILLE);
    expect(await api.market("austin")).toEqual(AUSTIN);
    expect(kv.reads).toBe(1);
    expect(logged("warn")).toEqual([]);
    expect(logged("error")).toEqual([]);
  });

  it("logs a partial value once, with the run id and the market ids, never a locality id", async () => {
    kv.value = { nashville: NASHVILLE, portland: PORTLAND };
    const api = kvLocalities(db, { runId: "run-invented-0002" });
    expect(await api.market("austin")).toBeNull();
    expect(await api.market("nashville")).toEqual(NASHVILLE);
    expect(await api.market("austin")).toBeNull();
    const lines = logged("warn");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("run-invented-0002");
    expect(lines[0]).toContain(missingJson(missingBut("nashville")));
    expect(lines[0]).toContain('"pinned":2');
    expect(lines[0]).toContain("pins only some markets");
    expect(lines.join("\n")).not.toContain("invented-locality");
  });

  it("logs a missing value, and every lookup resolves null", async () => {
    const api = kvLocalities(db, { runId: "run-invented-0003" });
    expect(await api.market("nashville")).toBeNull();
    expect(await api.market("austin")).toBeNull();
    const lines = logged("warn");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("is not set");
    expect(lines[0]).toContain(missingJson(REQUIRED));
  });

  it("logs a malformed value as an error, and every lookup rejects", async () => {
    kv.value = { nashville: { entityId: "invented-locality-0001" } };
    const api = kvLocalities(db, { runId: "run-invented-0004" });
    await expect(api.market("nashville")).rejects.toThrow('kv "metro_localities" is malformed');
    await expect(api.market("austin")).rejects.toThrow("malformed");
    expect(logged("error")).toHaveLength(1);
    expect(logged("error").join("\n")).not.toContain("invented-locality");
  });

  it("rejects when kv cannot be read, so a skill reports a failed lookup", async () => {
    kv.fail = true;
    await expect(kvLocalities(db).market("nashville")).rejects.toThrow("kv is unreadable");
  });

  it("resolves other markets' pins quietly, a run asking for every market it might offer, and never a prototype key", async () => {
    kv.value = { ...MAP_CITY_PINS, portland: PORTLAND };
    const api = kvLocalities(db, { runId: "run-invented-0005" });
    expect(await api.market("portland")).toEqual(PORTLAND);
    expect(await api.market("boise")).toBeNull();
    expect(await api.market("constructor")).toBeNull();
    expect(await api.market("hasOwnProperty")).toBeNull();
    expect(logged("warn")).toEqual([]);
    expect(kv.reads).toBe(1);
  });
});

describe("the key on synthetic Qloo data", () => {
  it("is metro_localities.mock with QLOO_MOCK=1, and metro_localities otherwise", () => {
    expect(MOCK_LOCALITIES_KV_KEY).toBe("metro_localities.mock");
    expect(localitiesKvKey()).toBe(LOCALITIES_KV_KEY);
    vi.stubEnv("QLOO_MOCK", "1");
    expect(localitiesKvKey()).toBe(MOCK_LOCALITIES_KV_KEY);
    expect(localitiesKvKey({ QLOO_MOCK: "0", NODE_ENV: "production" })).toBe(LOCALITIES_KV_KEY);
  });

  it("is read and logged by /status, startup and a run's lookups on the mock dev server", async () => {
    vi.stubEnv("QLOO_MOCK", "1");
    kv.key = "metro_localities.mock";
    kv.value = { nashville: NASHVILLE };
    expect(await readLocalityCoverage(db)).toMatchObject({ state: "partial", missing: missingBut("nashville") });
    const api = kvLocalities(db, { runId: "run-invented-0006" });
    expect(await api.market("nashville")).toEqual(NASHVILLE);
    const lines = logged("warn");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"key":"metro_localities.mock"');
    expect(lines.join("\n")).not.toContain("invented-locality");
  });

  it("gives way to the key a caller names", async () => {
    vi.stubEnv("QLOO_MOCK", "1");
    kv.value = MAP_CITY_PINS;
    expect(await readLocalityCoverage(db, LOCALITIES_KV_KEY)).toMatchObject({ state: "complete" });
    expect(await kvLocalities(db, {}, LOCALITIES_KV_KEY).market("austin")).toEqual(AUSTIN);
  });
});
