// The replay speeds (PLAN Part 6: "8× replay"): 8× joins 1×, 4× and 16× in the player and in both sets
// of controls, and paces like the others (the gap over the speed, a long pause capped).
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RUN_LIMITS, stampEvent, type EventInput, type RunEvent } from "@ct/contracts";
import { REPLAY_BAR_SPEEDS, ReplayBar, ReplayMini, type ReplayBarProps } from "../../components/brief/replay-bar";
import { ReplayPlayer, REPLAY_MAX_DELAY_MS, REPLAY_SPEEDS } from "../../lib/run-stream";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));

const RUN = "run-speed-test";
const T0 = Date.UTC(2026, 9, 14, 9, 12, 0);
const stamp = (seq: number, offsetMs: number, input: EventInput): RunEvent =>
  stampEvent(input, { seq, ts: new Date(T0 + offsetMs).toISOString(), runId: RUN });
const note = (seq: number, offsetMs: number) => stamp(seq, offsetMs, { type: "note", text: `note ${seq}` });

/** Gaps of 2 s, 8 s and 0.8 s. */
const RECORDING: RunEvent[] = [
  stamp(1, 0, { type: "run.created", question: "Is Juniper Cola a taste island?", mode: "live", lane: "public", limits: DEFAULT_RUN_LIMITS, parentRunId: null, model: "fake" }),
  note(2, 2000),
  note(3, 10_000),
  stamp(4, 10_800, { type: "run.end", status: "completed", elapsedMs: 10_800, reason: null }),
];

function props(over: Partial<ReplayBarProps> = {}): ReplayBarProps {
  return {
    playing: true,
    done: false,
    speed: 8,
    progress: 0.5,
    positionMs: 5_000,
    durationMs: 10_800,
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onSpeed: vi.fn(),
    onRestart: vi.fn(),
    exitHref: "/run/run-speed-test",
    ...over,
  };
}

describe("the replay speeds", () => {
  it("adds 8× and keeps the others", () => {
    expect(REPLAY_SPEEDS).toEqual([1, 4, 8, 16, "instant"]);
    expect(REPLAY_BAR_SPEEDS).toEqual([1, 4, 8, 16]);
  });

  it("offers 8× in the replay bar and the running head's controls, pressed when chosen", () => {
    const bar = renderToStaticMarkup(<ReplayBar {...props()} />);
    const radios = [...bar.matchAll(/role="radio" aria-checked="(true|false)"[^>]*>([^<]+)</g)].map((m) => [m[2], m[1]]);
    expect(radios).toEqual([
      ["1×", "false"],
      ["4×", "false"],
      ["8×", "true"],
      ["16×", "false"],
    ]);
    const mini = renderToStaticMarkup(<ReplayMini {...props({ speed: 4 })} />);
    const buttons = [...mini.matchAll(/aria-pressed="(true|false)" aria-label="([^"]+)"/g)].map((m) => [m[2], m[1]]);
    expect(buttons).toEqual([
      ["1× speed", "false"],
      ["4× speed", "true"],
      ["8× speed", "false"],
      ["16× speed", "false"],
    ]);
  });
});

describe("an 8× replay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits an eighth of each gap, a long pause capped", () => {
    const p = new ReplayPlayer(RUN, { speed: 8, autoplay: false });
    for (const e of RECORDING) p.push(e);
    p.play();
    const applied = () => p.getSnapshot().applied;
    expect(applied()).toBe(1);
    // 2 s / 8 = 250 ms.
    vi.advanceTimersByTime(249);
    expect(applied()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(applied()).toBe(2);
    // 8 s / 8 = 1 s, capped.
    vi.advanceTimersByTime(REPLAY_MAX_DELAY_MS - 1);
    expect(applied()).toBe(2);
    vi.advanceTimersByTime(1);
    expect(applied()).toBe(3);
    // 0.8 s / 8 = 100 ms.
    vi.advanceTimersByTime(100);
    expect(p.getSnapshot()).toMatchObject({ applied: 4, done: true, speed: 8 });
  });

  it("rescales the wait left when switched from 4× to 8×", () => {
    const p = new ReplayPlayer(RUN, { speed: 4, autoplay: false });
    for (const e of RECORDING) p.push(e);
    p.play();
    // 2 s / 4 = 500 ms; half of it gone, the 250 ms left becomes 125 ms.
    vi.advanceTimersByTime(250);
    p.setSpeed(8);
    vi.advanceTimersByTime(124);
    expect(p.getSnapshot().applied).toBe(1);
    vi.advanceTimersByTime(1);
    expect(p.getSnapshot().applied).toBe(2);
  });
});
