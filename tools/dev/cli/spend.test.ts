import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSpend, readSpend, readUsdCap, reserveSpend, settleSpend, SpendFileError } from "./spend";

const dirs: string[] = [];
const tempFile = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-spend-"));
  dirs.push(dir);
  return path.join(dir, "nested", "spend.json");
};
const at = (iso: string): Date => new Date(iso);

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the spend tally", () => {
  it("starts at zero when the file does not exist yet", () => {
    expect(readSpend(tempFile())).toEqual({ usd: 0, runs: 0, updatedAt: null });
  });

  it("books a run's worst case and replaces it with what the run measured", () => {
    const file = tempFile();
    const booked = reserveSpend(file, 15, 0.6, at("2026-10-22T01:00:00Z"));
    expect(booked.check.ok).toBe(true);
    expect(booked.tally).toEqual({ usd: 0.6, runs: 1, updatedAt: "2026-10-22T01:00:00.000Z" });
    expect(readSpend(file)).toEqual(booked.tally);
    const settled = settleSpend(file, 0.25 - 0.6, at("2026-10-22T01:05:00Z"));
    expect(settled.usd).toBeCloseTo(0.25);
    expect(settled.runs).toBe(1);
    // No temporary file is left behind.
    expect(readdirSync(path.dirname(file))).toEqual(["spend.json"]);
  });

  it("refuses a booking that would pass the cap and leaves the tally as it was", () => {
    const file = tempFile();
    reserveSpend(file, 1, 0.6, at("2026-10-22T01:00:00Z"));
    // A second run started meanwhile sees the first run's worst case.
    const second = reserveSpend(file, 1, 0.6, at("2026-10-22T01:00:01Z"));
    expect(second.check).toEqual({ ok: false, capUsd: 1, spentUsd: 0.6, estimateUsd: 0.6 });
    expect(readSpend(file)).toEqual({ usd: 0.6, runs: 1, updatedAt: "2026-10-22T01:00:00.000Z" });
  });

  it("never settles below zero", () => {
    const file = tempFile();
    reserveSpend(file, 15, 0.1, at("2026-10-22T01:00:00Z"));
    expect(settleSpend(file, -5, at("2026-10-22T01:00:00Z")).usd).toBe(0);
  });

  it.each([
    ["not JSON", "{not json"],
    ["a negative amount", JSON.stringify({ usd: -1, runs: 0, updatedAt: null })],
    ["a fractional run count", JSON.stringify({ usd: 1, runs: 1.5, updatedAt: null })],
    ["a missing amount", JSON.stringify({ runs: 2, updatedAt: null })],
  ])("refuses a tally that is %s rather than start again from $0", (_label, body) => {
    const file = tempFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, "utf8");
    expect(() => readSpend(file)).toThrow(SpendFileError);
    expect(() => reserveSpend(file, 15, 0.6, new Date())).toThrow(/not a valid tally/);
  });

  it("refuses a tally it cannot read", () => {
    const dir = tempFile();
    // A directory where the file should be: reading it fails with something other than ENOENT.
    mkdirSync(dir, { recursive: true });
    expect(() => readSpend(dir)).toThrow(/cannot be read/);
  });
});

describe("the cap", () => {
  it("reads LLM_DEV_USD_CAP with a fallback and refuses nonsense", () => {
    expect(readUsdCap({}, "LLM_DEV_USD_CAP", 15)).toBe(15);
    expect(readUsdCap({ LLM_DEV_USD_CAP: " 2.5 " }, "LLM_DEV_USD_CAP", 15)).toBe(2.5);
    expect(() => readUsdCap({ LLM_DEV_USD_CAP: "-1" }, "LLM_DEV_USD_CAP", 15)).toThrow(/positive number/);
  });

  it("allows a run only when the spend so far plus its worst case fits", () => {
    expect(checkSpend(15, 14, 0.6).ok).toBe(true);
    expect(checkSpend(15, 14.5, 0.6).ok).toBe(false);
  });
});
