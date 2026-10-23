// Replay (D26: 0 Qloo calls, $0): the controls, the REPLAY marker that keeps a replay from passing for
// a live run, and a recorded run served by the stand-in stream the dev sample viewer uses.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reduceRunEvents } from "@ct/contracts";
import { RunSession } from "../../lib/run-stream";
import { recordedEventSource, REPLAY_BAR_SPEEDS, ReplayBar, type ReplayBarProps } from "../../components/brief";
import { attrValues, events, renderState, slice, stateOf, tagOf, text, upTo } from "./support";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("../../components/ask/top-bar-ask", () => ({ TopBarAsk: () => null }));

const SAMPLE = events("brand-health");

function bar(over: Partial<ReplayBarProps> = {}): string {
  const props: ReplayBarProps = {
    playing: true,
    done: false,
    speed: 4,
    progress: 0.28,
    positionMs: 13_000,
    durationMs: 46_000,
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onSpeed: vi.fn(),
    onRestart: vi.fn(),
    exitHref: "/run/sample-brand-health",
    ...over,
  };
  return renderToStaticMarkup(<ReplayBar {...props} />);
}

describe("the replay bar", () => {
  it("marks the replay, and offers pause, the three speeds, restart, progress and exit", () => {
    const html = bar();
    expect(attrValues(html, "data-marker")).toEqual(["REPLAY"]);
    expect(text(html)).toContain("0 Qloo calls · $0");
    expect(text(html)).toContain("Pause");
    expect(REPLAY_BAR_SPEEDS).toEqual([1, 4, 16]);
    const speeds = [...html.matchAll(/role="radio" aria-checked="(true|false)"[^>]*>([^<]+)</g)].map((m) => [m[2], m[1]]);
    expect(speeds).toEqual([
      ["1×", "false"],
      ["4×", "true"],
      ["16×", "false"],
    ]);
    expect(text(html)).toContain("Restart");
    expect(tagOf(html, 'aria-label="Replay progress"')).toContain('aria-valuenow="28"');
    expect(text(html)).toContain("00:13 / 00:46");
    expect(html).toContain('href="/run/sample-brand-health"');
    expect(text(html)).toContain("Exit replay");
  });

  it("offers Play when paused and Play again once done", () => {
    expect(text(bar({ playing: false }))).toContain("Play");
    expect(bar({ playing: false })).toContain('data-replay="paused"');
    expect(text(bar({ playing: false, done: true, progress: 1 }))).toContain("Play again");
  });
});

describe("a brief in replay", () => {
  it("is marked REPLAY in the head and the running head, and never offers Stop run or a pick", () => {
    const list = upTo(SAMPLE, "plan");
    const state = stateOf(list);
    const { html, model } = renderState(state, Date.parse(list.at(-1)?.ts ?? "") + 1000, "replay", {
      replay: {
        playing: true,
        done: false,
        speed: 16,
        progress: 0.4,
        positionMs: 12_000,
        durationMs: 46_000,
        onPlay: vi.fn(),
        onPause: vi.fn(),
        onSpeed: vi.fn(),
        onRestart: vi.fn(),
        exitHref: "/run/x",
      },
    });
    expect(model.live).not.toBeNull();
    // The meta line, the replay bar and the running head each say REPLAY.
    expect(attrValues(html, "data-marker").filter((m) => m === "REPLAY").length).toBe(3);
    // The running head carries the replay's controls, for a reader who has scrolled past the bar.
    const head = slice(html, "data-running-head=", "<main");
    expect(head).toContain('data-marker="REPLAY"');
    expect(head).toContain('data-replay-mini="playing"');
    expect(head).toContain('aria-label="Pause the replay"');
    expect(attrValues(head, "aria-pressed")).toEqual(["false", "false", "true"]);
    expect(tagOf(head, 'aria-label="Replay progress"')).toContain('aria-valuenow="40"');
    // The run's meters show what it used, but there is nothing to stop.
    expect(html).toContain('aria-label="This run"');
    expect(html).not.toContain("Stop run");
    expect(html).not.toContain('aria-keyshortcuts="Escape"');
    expect(html).not.toContain('aria-label="Follow up"');
    // Screen readers hear a replay as one, and the outline does not call it "being written".
    expect(text(slice(html, 'aria-live="polite" aria-atomic="true"', "</p>"))).toMatch(/^Replay: /);
    const outline = text(slice(html, 'aria-label="On this brief"', "</nav>"));
    expect(outline).not.toContain("Being written");
    expect(outline).toContain(`Replay of a run recorded ${model.header.date}`);
  });
});

describe("a recorded run through the stand-in stream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("serves the events after the cursor, then the replay plays them into the run's final state", () => {
    const seen: number[] = [];
    const source = recordedEventSource(SAMPLE)("/api/runs/sample-brand-health/stream?after=100");
    source.onmessage = (message) => seen.push(JSON.parse(String(message.data)).seq);
    vi.runAllTimers();
    expect(seen).toEqual(SAMPLE.filter((e) => e.seq > 100).map((e) => e.seq));

    const runId = SAMPLE[0]?.runId ?? "missing";
    const session = new RunSession(runId, true, {
      replay: { speed: 16 },
      client: { createEventSource: recordedEventSource(SAMPLE), probeRun: async () => ({ status: 200, ended: true, lastSeq: SAMPLE.length }) },
    });
    const detach = session.attach(true);
    vi.runAllTimers();
    const played = session.player?.getSnapshot();
    expect(played?.done).toBe(true);
    expect(played?.state).toEqual(reduceRunEvents(runId, SAMPLE));
    detach();
  });
});
