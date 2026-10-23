// sample-run in process: the committed samples are what the script builds now, and the virtual clock
// the runs use fires timers in due order without touching real time. No network, no database.
import { readFileSync } from "node:fs";
import { RunEvent } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { buildSamples, renderSample, SAMPLE_NAMES, sampleFile, VirtualClock } from "./sample-run";

describe("sample-run", () => {
  it("keeps apps/web/server/samples in sync with the script (run `pnpm exec tsx tools/dev/sample-run.ts`)", async () => {
    const samples = await buildSamples();
    expect(samples.map((s) => s.name)).toEqual([...SAMPLE_NAMES]);
    for (const sample of samples) {
      // Parsed, so a checkout with CRLF line endings compares equal.
      const committed: unknown = JSON.parse(readFileSync(sampleFile(sample.name), "utf8"));
      expect(committed, sample.name).toEqual(JSON.parse(renderSample(sample.events)));
      for (const event of sample.events) expect(() => RunEvent.parse(event)).not.toThrow();
      expect(sample.events.map((e) => e.seq)).toEqual(sample.events.map((_, i) => i + 1));
      expect(sample.events.at(-1)?.type).toBe("run.end");
    }
  }, 60_000);

  it("writes one event per line", () => {
    const events = JSON.parse(readFileSync(sampleFile("needs-input"), "utf8")) as RunEvent[];
    const lines = renderSample(events).split("\n");
    expect(lines[0]).toBe("[");
    expect(lines.at(-2)).toBe("]");
    expect(lines).toHaveLength(events.length + 3);
  });
});

describe("VirtualClock", () => {
  it("fires timers in due order, ties in the order they were set, and reads its own time", async () => {
    const clock = new VirtualClock(1_000);
    const fired: string[] = [];
    const result = await clock.run(async () => {
      setTimeout(() => fired.push(`b@${clock.now()}`), 300);
      setTimeout(() => fired.push(`a@${clock.now()}`), 100);
      setTimeout(() => fired.push(`c@${clock.now()}`), 300);
      await clock.sleep(500);
      return clock.now();
    });
    expect(fired).toEqual(["a@1100", "b@1300", "c@1300"]);
    expect(result).toBe(1_500);
  });

  it("cancels cleared timers and rejects a sleep whose signal aborts", async () => {
    const clock = new VirtualClock(0);
    const fired: number[] = [];
    await clock.run(async () => {
      const timer = setTimeout(() => fired.push(1), 50);
      clearTimeout(timer);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("stop")), 20);
      await expect(clock.sleep(1_000, controller.signal)).rejects.toThrow("stop");
      expect(clock.now()).toBe(20);
    });
    expect(fired).toEqual([]);
  });

  it("leaves real timers alone outside its runs", async () => {
    const clock = new VirtualClock(0);
    let realFired = false;
    const real = new Promise<void>((resolve) =>
      setTimeout(() => {
        realFired = true;
        resolve();
      }, 5),
    );
    await clock.run(() => clock.sleep(60_000));
    await real;
    expect(realFired).toBe(true);
    expect(clock.now()).toBe(60_000);
  });
});
