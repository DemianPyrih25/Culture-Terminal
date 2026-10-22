// openCliQloo's store choice: --memory runs on synthetic data only, since live calls must go through
// the shared Postgres cache that counts the QLOO_TAG cap. No database, no network.
import { describe, expect, it } from "vitest";
import { CliError, MEMORY_NEEDS_MOCK, openCliQloo, postgresUnreachable, stderrLogger } from "./qloo-setup";

const logger = stderrLogger(() => undefined);
const LIVE = { QLOO_API_KEY: "test-key-not-real", QLOO_TAG_CAP: "200" };

describe("openCliQloo with --memory", () => {
  it.each([
    ["no QLOO_MOCK", LIVE],
    ["QLOO_MOCK=0", { ...LIVE, QLOO_MOCK: "0" }],
  ])("refuses live Qloo (%s)", async (_label, env) => {
    const opened = openCliQloo({ env, mock: false, tag: "dev-tools-test", store: "memory", logger });
    await expect(opened).rejects.toThrow(CliError);
    await expect(opened).rejects.toThrow(MEMORY_NEEDS_MOCK);
  });

  it("opens on synthetic data, from the mock flag or QLOO_MOCK=1", async () => {
    for (const [env, mock] of [
      [{}, true],
      [{ QLOO_MOCK: "1" }, false],
    ] as const) {
      const qloo = await openCliQloo({ env, mock, tag: null, store: "memory", logger });
      expect(qloo.client.env).toBe("mock");
      expect(qloo.storeLabel).toBe("memory (nothing persists)");
      await qloo.close();
    }
  });

  it("reports a bad QLOO_MOCK as a plain CLI error", async () => {
    await expect(openCliQloo({ env: { QLOO_MOCK: "yes" }, mock: false, tag: null, store: "memory", logger })).rejects.toThrow(
      new CliError('QLOO_MOCK must be "1" (synthetic data) or "0" (live Qloo), got "yes"'),
    );
  });
});

describe("postgresUnreachable", () => {
  const env = { DATABASE_URL: "postgres://localhost:5433/culture_terminal" };

  it("offers --memory only on synthetic data", () => {
    expect(postgresUnreachable(env, "mock")).toBe(
      "Postgres is not reachable at localhost:5433/culture_terminal. Start it with `pnpm db:up`, or pass --memory to cache in memory only.",
    );
    for (const qlooEnv of ["dev", "prod"] as const) {
      const message = postgresUnreachable(env, qlooEnv);
      expect(message).toContain("Start it with `pnpm db:up`: live Qloo calls need the shared cache");
      expect(message).not.toContain("--memory");
    }
  });
});
