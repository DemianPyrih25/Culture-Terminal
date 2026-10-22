import { describe, expect, it } from "vitest";
import { DEV_DATABASE_URL, isConnectionError, resolveDatabaseUrl } from "../src/client";
import { isSkippableProbeError, pgCode, withDatabase } from "./support/testDb";

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

describe("resolveDatabaseUrl", () => {
  it("uses DATABASE_URL when set", () => {
    expect(resolveDatabaseUrl(env({ DATABASE_URL: "postgres://u:p@db.internal:5432/app" }))).toEqual({
      url: "postgres://u:p@db.internal:5432/app",
      isDefault: false,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(resolveDatabaseUrl(env({ DATABASE_URL: "  postgres://h/app \n" })).url).toBe("postgres://h/app");
  });

  it("falls back to the compose database outside production", () => {
    for (const NODE_ENV of ["development", "test", ""]) {
      expect(resolveDatabaseUrl(env({ NODE_ENV }))).toEqual({ url: DEV_DATABASE_URL, isDefault: true });
    }
    expect(resolveDatabaseUrl(env({ DATABASE_URL: "   " })).isDefault).toBe(true);
    expect(DEV_DATABASE_URL).toBe("postgres://ct:ct@localhost:5433/culture_terminal");
  });

  it("throws in production when DATABASE_URL is missing or blank", () => {
    expect(() => resolveDatabaseUrl(env({ NODE_ENV: "production" }))).toThrow(/DATABASE_URL/);
    expect(() => resolveDatabaseUrl(env({ NODE_ENV: "production", DATABASE_URL: "" }))).toThrow(/DATABASE_URL/);
  });
});

describe("isConnectionError", () => {
  const withCode = (code: string) => Object.assign(new Error(code), { code });

  it("recognises network and postgres.js connection failures", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "57P03"]) {
      expect(isConnectionError(withCode(code))).toBe(true);
    }
  });

  it("looks inside dual-stack AggregateErrors and wrapped causes", () => {
    expect(isConnectionError(new AggregateError([withCode("ECONNREFUSED"), withCode("ECONNREFUSED")]))).toBe(true);
    expect(isConnectionError(new Error("Failed query", { cause: withCode("ECONNRESET") }))).toBe(true);
  });

  it("does not treat server-side errors as unreachable", () => {
    for (const code of ["28P01", "3D000", "23505", "42P01"]) {
      expect(isConnectionError(withCode(code))).toBe(false);
    }
    expect(isConnectionError(new Error("boom"))).toBe(false);
    expect(isConnectionError(null)).toBe(false);
    expect(isConnectionError("ECONNREFUSED")).toBe(false);
  });
});

describe("integration-test skip rule", () => {
  const withCode = (code: string) => Object.assign(new Error(code), { code });

  it("skips only when the target cannot be reached", () => {
    expect(isSkippableProbeError(withCode("ECONNREFUSED"), false)).toBe(true);
    expect(isSkippableProbeError(withCode("28P01"), false)).toBe(false);
    expect(isSkippableProbeError(new Error("syntax"), false)).toBe(false);
  });

  it("treats another server on the compose default port as 'compose database not running'", () => {
    expect(isSkippableProbeError(withCode("28P01"), true)).toBe(true);
    expect(isSkippableProbeError(withCode("3D000"), true)).toBe(true);
    expect(isSkippableProbeError(withCode("42501"), true)).toBe(false);
  });

  it("swaps the database name and keeps credentials and options", () => {
    expect(withDatabase("postgres://ct:ct@localhost:5433/culture_terminal?sslmode=disable", "ct_test_1")).toBe(
      "postgres://ct:ct@localhost:5433/ct_test_1?sslmode=disable",
    );
  });

  it("finds the SQLSTATE behind a wrapped error", () => {
    expect(pgCode(new Error("Failed query", { cause: withCode("23505") }))).toBe("23505");
    expect(pgCode(new Error("plain"))).toBeUndefined();
  });
});
