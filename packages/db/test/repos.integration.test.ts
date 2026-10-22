// Runs against a real Postgres (DATABASE_URL, else the docker-compose default) in a throwaway
// database. Skips only when no database is reachable; in CI with DATABASE_URL set it never skips.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/client";
import { deleteKv, getKv, getKvEntry, setKv } from "../src/repos/kv";
import { appendEvents, lastSeq, listEvents, type RunEventInput } from "../src/repos/runEvents";
import {
  createRun,
  findAnswerCache,
  getRun,
  isCancelRequested,
  requestCancel,
  setStatus,
  updateRun,
} from "../src/repos/runs";
import { type NewRun, runEvents, runs } from "../src/schema";
import { createTestDatabase, pgCode, probeTestDatabase, type TestDatabase } from "./support/testDb";

const probe = await probeTestDatabase();

const HOUR = 3600 * 1000;

describe.skipIf(!probe.ok)("repos against Postgres", () => {
  let t: TestDatabase | undefined;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  const newRun = (over: Partial<NewRun> = {}) =>
    createRun(db, { question: "Is Aurora Footwear a taste island?", questionHash: "h-aurora", ...over });

  const events = (seqs: number[], text = (s: number) => `e${s}`): RunEventInput[] =>
    seqs.map((seq) => ({ seq, type: "note", payload: { text: text(seq) } }));

  // updated_at has no trigger: each write must set it. Backdating the row first makes a missing
  // bump visible, which a >= comparison against a row created a moment ago would hide.
  const backdateRun = (id: string) =>
    db.execute(sql`update runs set updated_at = now() - interval '1 hour' where id = ${id}`);
  const isFresh = (d: Date | undefined) => d !== undefined && Math.abs(Date.now() - d.getTime()) < 60_000;

  describe("runs", () => {
    it("creates a run with defaults and reads it back", async () => {
      const run = await newRun();
      expect(run).toMatchObject({
        status: "queued",
        mode: "live",
        lane: "public",
        isShowcase: false,
        llmUsd: 0,
        tokens: 0,
        qlooNetwork: 0,
        qlooCached: 0,
        cancelRequestedAt: null,
        parentRunId: null,
      });
      expect(run.id).toMatch(/\S{8,}/);
      expect(run.createdAt).toBeInstanceOf(Date);
      expect(await getRun(db, run.id)).toEqual(run);
      expect(await getRun(db, "no-such-run")).toBeUndefined();
    });

    it("keeps a caller-assigned id and stores jsonb as JSON, not as a string", async () => {
      const intent = { pillar: "investment", job: "brand_health", mentions: ["Aurora Footwear", "Juniper Cola"] };
      const run = await newRun({ id: "run-aurora-1", intent, pins: { R1: "aurora-footwear" }, mode: "economy" });
      expect(run.id).toBe("run-aurora-1");
      expect((await getRun(db, run.id))?.intent).toEqual(intent);
      const [row] = await db.execute<{ kind: string }>(
        sql`select jsonb_typeof(intent) as kind from runs where id = ${run.id}`,
      );
      expect(row?.kind).toBe("object");
    });

    it("links child runs and clears the link when the parent is deleted", async () => {
      const parent = await newRun();
      const child = await newRun({ parentRunId: parent.id });
      expect(child.parentRunId).toBe(parent.id);
      await db.delete(runs).where(eq(runs.id, parent.id));
      expect((await getRun(db, child.id))?.parentRunId).toBeNull();
    });

    it("sets status, bumps updated_at and honours the compare-and-set guard", async () => {
      const run = await newRun();
      await backdateRun(run.id);
      expect(await setStatus(db, run.id, "running")).toBe(true);
      const running = await getRun(db, run.id);
      expect(running?.status).toBe("running");
      expect(isFresh(running?.updatedAt)).toBe(true);

      expect(await setStatus(db, run.id, "completed", { from: ["queued"] })).toBe(false);
      expect((await getRun(db, run.id))?.status).toBe("running");

      const report = { headline: "Aurora Footwear is a taste island", signal: "mixed" };
      expect(
        await setStatus(db, run.id, "completed", { from: ["running"], patch: { wallMs: 4321, report } }),
      ).toBe(true);
      expect(await getRun(db, run.id)).toMatchObject({ status: "completed", wallMs: 4321, report });

      expect(await setStatus(db, run.id, "failed", { from: [] })).toBe(false);
      expect(await setStatus(db, "no-such-run", "running")).toBe(false);
    });

    it("rejects a status outside the state machine at the database", async () => {
      const run = await newRun();
      const err = await db.execute(sql`update runs set status = 'exploded' where id = ${run.id}`).catch((e) => e);
      expect(pgCode(err)).toBe("23514");
    });

    it("patches cost and result columns and bumps updated_at", async () => {
      const run = await newRun();
      await backdateRun(run.id);
      const updated = await updateRun(db, run.id, {
        model: "claude-sonnet-5-5",
        effort: "medium",
        llmUsd: 0.21,
        tokens: 18000,
        qlooNetwork: 12,
        qlooCached: 9,
        validation: { ok: true, issues: [] },
      });
      expect(updated).toMatchObject({ llmUsd: 0.21, tokens: 18000, qlooNetwork: 12, qlooCached: 9 });
      expect(updated?.validation).toEqual({ ok: true, issues: [] });
      expect(isFresh(updated?.updatedAt)).toBe(true);
      expect(await updateRun(db, "no-such-run", { tokens: 1 })).toBeUndefined();
    });

    it("raises a sticky cancel flag", async () => {
      const run = await newRun();
      await backdateRun(run.id);
      expect(await isCancelRequested(db, run.id)).toBe(false);
      expect(await requestCancel(db, run.id)).toBe(true);
      expect(await isCancelRequested(db, run.id)).toBe(true);
      const cancelled = await getRun(db, run.id);
      const first = cancelled?.cancelRequestedAt;
      expect(first).toBeInstanceOf(Date);
      expect(isFresh(cancelled?.updatedAt)).toBe(true);

      expect(await requestCancel(db, run.id)).toBe(true);
      expect((await getRun(db, run.id))?.cancelRequestedAt).toEqual(first);

      expect(await requestCancel(db, "no-such-run")).toBe(false);
      expect(await isCancelRequested(db, "no-such-run")).toBe(false);
    });

    it("finds the newest completed run for a hash within 72 hours", async () => {
      const hash = "h-juniper-cola";
      const ago = (ms: number) => new Date(Date.now() - ms);
      await newRun({ questionHash: hash, status: "completed", createdAt: ago(73 * HOUR) });
      await newRun({ questionHash: hash, status: "completed", createdAt: ago(2 * HOUR) });
      const expected = await newRun({ questionHash: hash, status: "completed", createdAt: ago(1 * HOUR) });
      await newRun({ questionHash: hash, status: "running" });
      await newRun({ questionHash: hash, status: "failed" });
      await newRun({ questionHash: "h-marlowe-ridge", status: "completed" });

      expect((await findAnswerCache(db, hash))?.id).toBe(expected.id);
      expect(await findAnswerCache(db, hash, HOUR / 2)).toBeUndefined();
      expect(await findAnswerCache(db, "h-unknown")).toBeUndefined();

      const onlyOld = "h-only-old";
      await newRun({ questionHash: onlyOld, status: "completed", createdAt: ago(80 * HOUR) });
      expect(await findAnswerCache(db, onlyOld)).toBeUndefined();
    });
  });

  describe("run events", () => {
    it("appends events and skips duplicate seqs without overwriting them", async () => {
      const run = await newRun();
      expect(await appendEvents(db, run.id, events([0, 1, 2, 3, 4]))).toBe(5);
      expect(await appendEvents(db, run.id, events([3, 4, 5], () => "retry"))).toBe(1);
      expect(await appendEvents(db, run.id, events([3, 4, 5], () => "retry"))).toBe(0);
      expect(await appendEvents(db, run.id, [])).toBe(0);

      const rows = await listEvents(db, run.id);
      expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(rows.find((r) => r.seq === 3)?.payload).toEqual({ text: "e3" });
      expect(rows.find((r) => r.seq === 5)?.payload).toEqual({ text: "retry" });
    });

    it("lets concurrent duplicate flushes insert each seq exactly once", async () => {
      const run = await newRun();
      const batch = events(Array.from({ length: 50 }, (_, i) => i));
      const counts = await Promise.all([
        appendEvents(db, run.id, batch),
        appendEvents(db, run.id, batch),
        appendEvents(db, run.id, batch),
      ]);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(50);
      expect(await lastSeq(db, run.id)).toBe(49);
    });

    it("lists after a seq in seq order, whatever the insert order, with a limit", async () => {
      const run = await newRun();
      const ts = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000 + 123);
      await appendEvents(db, run.id, [
        { seq: 9, type: "run.end", payload: { status: "completed" }, ts },
        ...events([7, 8, 6]),
      ]);
      expect((await listEvents(db, run.id)).map((r) => r.seq)).toEqual([6, 7, 8, 9]);
      expect((await listEvents(db, run.id, 7)).map((r) => r.seq)).toEqual([8, 9]);
      expect((await listEvents(db, run.id, 6, 2)).map((r) => r.seq)).toEqual([7, 8]);
      expect(await listEvents(db, run.id, 9)).toEqual([]);

      const [end] = await listEvents(db, run.id, 8);
      expect(end).toMatchObject({ runId: run.id, seq: 9, type: "run.end", payload: { status: "completed" } });
      expect(end?.ts.toISOString()).toBe(ts.toISOString());
    });

    it("pages through batches larger than one insert chunk", async () => {
      const run = await newRun();
      const seqs = Array.from({ length: 2500 }, (_, i) => i);
      expect(await appendEvents(db, run.id, events(seqs))).toBe(2500);
      const page1 = await listEvents(db, run.id);
      expect(page1).toHaveLength(1000);
      const page3 = await listEvents(db, run.id, 1999);
      expect(page3.map((r) => r.seq)).toEqual(seqs.slice(2000));
    });

    it("reports the last seq, or null without events", async () => {
      const run = await newRun();
      expect(await lastSeq(db, run.id)).toBeNull();
      await appendEvents(db, run.id, events([3, 1, 2]));
      expect(await lastSeq(db, run.id)).toBe(3);
      expect(await lastSeq(db, "no-such-run")).toBeNull();
    });

    it("validates seq and limit before touching the database", async () => {
      const run = await newRun();
      for (const seq of [-1, 1.5, 2 ** 31, Number.NaN]) {
        await expect(appendEvents(db, run.id, events([0, seq]))).rejects.toThrow(RangeError);
      }
      expect(await lastSeq(db, run.id)).toBeNull();
      await expect(listEvents(db, run.id, undefined, 0)).rejects.toThrow(RangeError);
    });

    it("rejects events for an unknown run and drops events with their run", async () => {
      const err = await appendEvents(db, "no-such-run", events([0])).catch((e) => e);
      expect(pgCode(err)).toBe("23503");

      const run = await newRun();
      await appendEvents(db, run.id, events([0, 1]));
      await db.delete(runs).where(eq(runs.id, run.id));
      const left = await db.select().from(runEvents).where(eq(runEvents.runId, run.id));
      expect(left).toEqual([]);
    });
  });

  describe("kv", () => {
    it("returns undefined for a missing key", async () => {
      expect(await getKv(db, "missing")).toBeUndefined();
      expect(await getKvEntry(db, "missing")).toBeUndefined();
    });

    it("round-trips JSON values and replaces them on write", async () => {
      await setKv(db, "mode", "normal");
      expect(await getKv(db, "mode")).toBe("normal");
      await db.execute(sql`update kv set updated_at = now() - interval '1 hour' where key = 'mode'`);
      const before = await getKvEntry(db, "mode");

      await setKv(db, "mode", "replay_only");
      const after = await getKvEntry(db, "mode");
      expect(after?.value).toBe("replay_only");
      expect(isFresh(after?.updatedAt)).toBe(true);
      expect(after!.updatedAt.getTime() - before!.updatedAt.getTime()).toBeGreaterThan(30 * 60_000);

      const snapshot = { monthRemaining: 12345, floor: 2000, metros: ["nashville", "austin"], ok: true };
      await setKv(db, "quota.snapshot", snapshot);
      expect(await getKv(db, "quota.snapshot")).toEqual(snapshot);

      await setKv(db, "count", 0);
      expect(await getKv(db, "count")).toBe(0);
      await setKv(db, "breaker.open", false);
      expect(await getKv(db, "breaker.open")).toBe(false);
    });

    it("refuses null and undefined, and deletes keys instead", async () => {
      await expect(setKv(db, "bad", undefined)).rejects.toThrow(TypeError);
      await expect(setKv(db, "bad", null)).rejects.toThrow(TypeError);
      expect(await getKvEntry(db, "bad")).toBeUndefined();

      await setKv(db, "temp", { on: true });
      expect(await deleteKv(db, "temp")).toBe(true);
      expect(await getKv(db, "temp")).toBeUndefined();
      expect(await deleteKv(db, "temp")).toBe(false);
    });
  });
});
