// This browser's own briefs (D31): kept in localStorage, newest first, bounded, and harmless when
// storage is missing, full or blocked. Run ids are invented.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserStorage,
  clearRecentRuns,
  forgetRun,
  restoreRun,
  readRecentRunIds,
  recentIdsParam,
  rememberRun,
  RECENT_BRIEFS_SLOT,
  RECENT_BRIEFS_MAX,
  RECENT_BRIEFS_QUERY_MAX,
  type StorageLike,
} from "../../lib/recent-briefs";

class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

const id = (n: number) => `run-brief-${String(n).padStart(4, "0")}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recent briefs storage", () => {
  it("keeps run ids newest first, once each", () => {
    const storage = new MemoryStorage();
    expect(readRecentRunIds(storage)).toEqual([]);
    rememberRun(id(1), storage);
    rememberRun(id(2), storage);
    expect(rememberRun(id(1), storage)).toEqual([id(1), id(2)]);
    expect(readRecentRunIds(storage)).toEqual([id(1), id(2)]);
    expect(JSON.parse(storage.getItem(RECENT_BRIEFS_SLOT) ?? "null")).toEqual([id(1), id(2)]);
  });

  it("keeps at most the newest 100", () => {
    const storage = new MemoryStorage();
    for (let n = 0; n < RECENT_BRIEFS_MAX + 5; n++) rememberRun(id(n), storage);
    const ids = readRecentRunIds(storage);
    expect(ids).toHaveLength(RECENT_BRIEFS_MAX);
    expect(ids[0]).toBe(id(RECENT_BRIEFS_MAX + 4));
    expect(ids).not.toContain(id(4));
  });

  it("reads anything else in its key as nothing, and drops values that are not run ids", () => {
    const storage = new MemoryStorage();
    for (const raw of ["not json", '{"a":1}', "42", "null"]) {
      storage.setItem(RECENT_BRIEFS_SLOT, raw);
      expect(readRecentRunIds(storage)).toEqual([]);
    }
    storage.setItem(RECENT_BRIEFS_SLOT, JSON.stringify([id(1), 7, "../etc", id(1), id(2), "short"]));
    expect(readRecentRunIds(storage)).toEqual([id(1), id(2)]);
    // A value that is not a run id is never stored.
    expect(rememberRun("not a run id", storage)).toEqual([id(1), id(2)]);
  });

  it("works without storage, and when reading or writing it throws", () => {
    expect(readRecentRunIds(null)).toEqual([]);
    expect(rememberRun(id(1), null)).toEqual([id(1)]);
    const blocked: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readRecentRunIds(blocked)).toEqual([]);
    expect(() => rememberRun(id(1), blocked)).not.toThrow();
  });

  it("finds no storage on the server, or where touching localStorage throws", () => {
    expect(browserStorage()).toBeNull();
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("SecurityError: the operation is insecure");
      },
    });
    expect(browserStorage()).toBeNull();
    expect(readRecentRunIds()).toEqual([]);
    expect(rememberRun(id(1))).toEqual([id(1)]);
  });

  it("names the newest 50 to the list endpoint", () => {
    expect(recentIdsParam([])).toBeNull();
    const ids = Array.from({ length: 70 }, (_, n) => id(n));
    const param = recentIdsParam(ids) ?? "";
    expect(param.split(",")).toEqual(ids.slice(0, RECENT_BRIEFS_QUERY_MAX));
    expect(recentIdsParam(["bad id", id(1)])).toBe(id(1));
  });
});

describe("forgetting, restoring and clearing", () => {
  it("forgets a run and puts it back at its old place", () => {
    const storage = new MemoryStorage();
    for (const n of [3, 2, 1]) rememberRun(id(n), storage);
    expect(forgetRun(id(2), storage)).toBe(1);
    expect(readRecentRunIds(storage)).toEqual([id(1), id(3)]);
    expect(forgetRun(id(9), storage)).toBe(-1);
    expect(restoreRun(id(2), 1, storage)).toEqual([id(1), id(2), id(3)]);
    expect(restoreRun(id(2), 0, storage)).toEqual([id(1), id(2), id(3)]);
    expect(restoreRun(id(4), 99, storage)).toEqual([id(1), id(2), id(3), id(4)]);
    expect(restoreRun("bad id", 0, storage)).toEqual([id(1), id(2), id(3), id(4)]);
  });

  it("clears the list, and never throws without storage", () => {
    const storage = new MemoryStorage();
    rememberRun(id(1), storage);
    expect(clearRecentRuns(storage)).toBe(true);
    expect(readRecentRunIds(storage)).toEqual([]);
    expect(clearRecentRuns(null)).toBe(false);
    expect(forgetRun(id(1), null)).toBe(-1);
    expect(restoreRun(id(1), 0, null)).toEqual([id(1)]);
  });
});
