// countLaneRunsSince (server/run-counts.ts): a lane's agent runs in a window, counting only runs that
// started (started_at set), so a run that never left the queue counts toward no cap (Part 10 open issue).
// The statement is checked as built; the behaviour against Postgres is in run-manager-limits.integration.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { countLaneRunsSince } = await import("../../server/run-counts");

function fakeDb(n: number) {
  const statements: string[] = [];
  const db = {
    execute: async (statement: string) => {
      statements.push(statement);
      return [{ n }];
    },
  } as unknown as Parameters<typeof countLaneRunsSince>[0];
  return { db, statements };
}

describe("countLaneRunsSince", () => {
  it("counts only started runs of the lane, leaving dev CLI runs out", async () => {
    const { db, statements } = fakeDb(4);
    expect(await countLaneRunsSince(db, "judge", 3_600_000)).toBe(4);
    expect(statements[0]).toContain("lane = 'judge'");
    expect(statements[0]).toContain("started_at is not null");
    expect(statements[0]).toContain("id not like 'cli-%'");
    expect(statements[0]).toContain("make_interval(secs => 3600)");
  });

  it("refuses a window that is not a positive whole number of seconds", async () => {
    const { db } = fakeDb(0);
    await expect(countLaneRunsSince(db, "public", 0)).rejects.toThrow(RangeError);
  });
});
