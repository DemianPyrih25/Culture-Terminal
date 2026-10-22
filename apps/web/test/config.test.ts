import { describe, expect, it, vi } from "vitest";
import { fakeRunHourlyCapFromEnv, fakeRunRetentionMsFromEnv } from "../server/config";

vi.mock("server-only", () => ({}));

const HOUR = 3_600_000;
// Next.js types NODE_ENV as required.
const env = (vars: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...vars });

describe("fake run limits from the environment", () => {
  it("defaults to 60 runs an hour and six hours of retention, also for empty values", () => {
    expect(fakeRunHourlyCapFromEnv(env())).toBe(60);
    expect(fakeRunHourlyCapFromEnv(env({ FAKE_RUN_HOURLY_CAP: " " }))).toBe(60);
    expect(fakeRunRetentionMsFromEnv(env())).toBe(6 * HOUR);
    expect(fakeRunRetentionMsFromEnv(env({ FAKE_RUN_RETENTION_HOURS: "" }))).toBe(6 * HOUR);
  });

  it("reads and clamps the values", () => {
    expect(fakeRunHourlyCapFromEnv(env({ FAKE_RUN_HOURLY_CAP: "12" }))).toBe(12);
    expect(fakeRunHourlyCapFromEnv(env({ FAKE_RUN_HOURLY_CAP: "0" }))).toBe(1);
    expect(fakeRunHourlyCapFromEnv(env({ FAKE_RUN_HOURLY_CAP: "lots" }))).toBe(60);
    expect(fakeRunRetentionMsFromEnv(env({ FAKE_RUN_RETENTION_HOURS: "24" }))).toBe(24 * HOUR);
    // Never shorter than the cap's window, or a purge would let the cap count fewer runs.
    expect(fakeRunRetentionMsFromEnv(env({ FAKE_RUN_RETENTION_HOURS: "0.25" }))).toBe(HOUR);
  });
});
