// What the protection layer shows: the human check's card, the status line's mode, the replay-only
// banner, and the Ask panel's economy and paused states, rendered to markup from fixtures. The
// Turnstile widget itself is never rendered here (it loads Cloudflare's script). Invented entities only.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AskComposer } from "../../components/ask/ask-composer";
import { runRequestBody, type AskState } from "../../components/ask/ask-machine";
import { askStatusText, economyDetail, pausedExtra } from "../../components/ask/ask-panel";
import { ASK_GALLERY, FIXTURE_AT, FIXTURE_PREVIEW_ECONOMY, FIXTURE_PREVIEW_HAVE, FIXTURE_QUESTION } from "../../components/ask/fixtures";
import { HumanCheck, SCRIPT_ERROR, UNSUPPORTED_ERROR } from "../../components/protection/human-check";
import { HumanCheckCard, HumanCheckPanel, humanCheckCopy } from "../../components/protection/human-check-panel";
import { PAGE_GUTTER } from "../../components/layout/grid";
import { ModeBanner, modeBannerText, ModeBannerView, ModeStatus, modeStatusText, ModeStatusView } from "../../components/protection/mode-status";
import { parseCommand } from "../../lib/grammar/parse";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

function render(state: AskState, draft = FIXTURE_QUESTION): string {
  return renderToStaticMarkup(
    <AskComposer value={draft} onChange={() => undefined} onSubmit={() => undefined} state={state} compiled={parseCommand(draft)} onRun={() => undefined} />,
  );
}

const entry = (name: string) => {
  const found = ASK_GALLERY.find((e) => e.name.startsWith(name));
  if (!found) throw new Error(`no gallery entry ${name}`);
  return found;
};

/** The section of the panel labelled `label`. */
function section(html: string, label: string): string {
  const match = html.match(new RegExp(`<section aria-label="${label}".*?</section>`));
  if (!match) throw new Error(`no section ${label}`);
  return match[0];
}

describe("the human check's card", () => {
  it("says nothing while the check runs unseen, and asks the visitor when Cloudflare needs a click", () => {
    expect(humanCheckCopy({ status: "checking" })).toBeNull();
    const unseen = renderToStaticMarkup(
      <HumanCheckCard status="checking">
        <div id="widget" />
      </HumanCheckCard>,
    );
    expect(unseen).toContain('aria-hidden="true"');
    expect(unseen).toContain("h-0 overflow-hidden");
    expect(unseen).toContain('<div id="widget"></div>');

    const asking = renderToStaticMarkup(<HumanCheckCard status="interactive" />);
    expect(asking).toContain("Human check");
    expect(asking).toContain("Confirm you are a person to run live analysis");
    expect(asking).toContain("Showcases and replays need no check.");
    expect(asking).not.toContain("Try again");
    // Announced politely, for a screen reader whose focus stays in the question field.
    expect(asking).toMatch(/<div class="[^"]*" role="status"><p[^>]*>Confirm you are a person to run live analysis/);
  });

  it("offers Try again after an error, as an alert", () => {
    const failed = renderToStaticMarkup(<HumanCheckCard status="error" onRetry={() => undefined} />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("The check that you are a person could not run");
    expect(failed).toContain("Try again");
  });

  it("says when the check could not load, or cannot run in this browser", () => {
    expect(humanCheckCopy({ status: "error", error: SCRIPT_ERROR })).toEqual({
      head: "The check that you are a person could not load",
      detail: "Something in this browser or network blocked Cloudflare's check. Live briefs need it; showcases and replays still work.",
    });
    expect(humanCheckCopy({ status: "error", error: UNSUPPORTED_ERROR })?.head).toBe("This browser cannot run the check that you are a person");
    expect(humanCheckCopy({ status: "error", error: "110200" })?.head).toBe("The check that you are a person could not run");
    const blocked = renderToStaticMarkup(<HumanCheckCard status="error" error={SCRIPT_ERROR} onRetry={() => undefined} />);
    expect(blocked).toContain("could not load");
    expect(blocked).toContain("Try again");
    // The panel offers no Try again where it cannot help.
    expect(renderToStaticMarkup(<HumanCheckCard status="error" error={UNSUPPORTED_ERROR} />)).not.toContain("Try again");
  });

  it("tells the composer's live region that the reading waits for the check", () => {
    const loading: AskState = { phase: { kind: "loading", question: FIXTURE_QUESTION }, run: { kind: "idle" } };
    expect(askStatusText(loading, FIXTURE_QUESTION, true)).toBe("Waiting for the human check below the question.");
    expect(askStatusText(loading, FIXTURE_QUESTION)).toBe("Reading the question…");
    const html = renderToStaticMarkup(
      <AskComposer
        value={FIXTURE_QUESTION}
        onChange={() => undefined}
        onSubmit={() => undefined}
        state={loading}
        compiled={parseCommand(FIXTURE_QUESTION)}
        waitingForCheck
      />,
    );
    expect(html).toContain('<p role="status" aria-live="polite" class="sr-only">Waiting for the human check below the question.</p>');
    expect(html).toContain("Waiting for the human check below…");
  });

  it("renders nothing on the server: the widget waits for the browser to read its access", () => {
    expect(renderToStaticMarkup(<HumanCheckPanel check={new HumanCheck(async () => null)} />)).toBe("");
  });
});

describe("the mode in the status line and the banner", () => {
  it("names the mode, and the judge lane, and says nothing while live, on either lane", () => {
    expect(modeStatusText("public", "live")).toBeNull();
    expect(modeStatusText("public", "economy")).toBe("Economy analysis");
    expect(modeStatusText("public", "replay_only")).toBe("Replays only");
    expect(modeStatusText("judge", "live")).toBeNull();
    expect(modeStatusText("judge", "replay_only")).toBe("Judge lane · Replays only");
    // The phone strip's short words, beside the honesty line.
    expect(modeStatusText("public", "economy", true)).toBe("Economy");
    expect(modeStatusText("public", "replay_only", true)).toBe("Replays only");
    expect(modeStatusText("judge", "economy", true)).toBe("Judge · Economy");
    expect(modeStatusText("judge", "live", true)).toBeNull();
    expect(modeStatusText("public", "live", true)).toBeNull();
  });

  it("draws the status line's mode as a 6 px accent square and the word, the step-down's sentence as its title", () => {
    const html = renderToStaticMarkup(
      <ModeStatusView access={{ lane: "public", mode: "economy", message: "Live briefs run on the economy analyst." }} className="shrink-0" />,
    );
    expect(html).toContain('data-mode-status="economy"');
    expect(html).toContain('title="Live briefs run on the economy analyst."');
    expect(html).toMatch(/<span aria-hidden="true" class="size-1\.5 shrink-0 bg-accent"><\/span>Economy analysis<\/span>$/);
    expect(html).toContain("font-medium");
    expect(html).toContain("shrink-0");
    expect(renderToStaticMarkup(<ModeStatusView access={{ lane: "public", mode: "replay_only", message: null }} />)).toContain(">Replays only<");
    expect(renderToStaticMarkup(<ModeStatusView access={{ lane: "public", mode: "economy", message: null }} short />)).toMatch(/><\/span>Economy<\/span>$/);
  });

  it("hides the status line's mode while live, until the access is read, and when the mode could not be read", () => {
    expect(renderToStaticMarkup(<ModeStatusView access={{ lane: "public", mode: "live", message: null }} />)).toBe("");
    expect(renderToStaticMarkup(<ModeStatusView access={null} />)).toBe("");
    expect(renderToStaticMarkup(<ModeStatusView access={{ lane: "public", mode: null, message: null }} />)).toBe("");
    expect(renderToStaticMarkup(<ModeStatusView access={{ lane: "judge", mode: "live", message: null }} />)).toBe("");
  });

  it("draws the replay-only banner in the page gutter: the REPLAYS ONLY marker, then PLAN §11.6's sentence, never printed", () => {
    const html = renderToStaticMarkup(
      <ModeBannerView access={{ lane: "public", mode: "replay_only", message: "Live analysis is paused: today's budget is used up." }} />,
    );
    expect(html).toMatch(/^<div role="status" data-mode-banner="replay_only" class="[^"]*"/);
    for (const cls of ["border-b", "border-line", "bg-canvas", "print:hidden", PAGE_GUTTER]) expect(html).toContain(cls);
    expect(html).toContain("bg-accent-soft");
    expect(html).toContain("font-mono");
    expect(html).toContain(">Replays only</span>");
    expect(html).toContain("Live analysis is paused: today&#x27;s budget is used up. Showing recorded runs on real Qloo data.");
    expect(html.indexOf(">Replays only<")).toBeLessThan(html.indexOf("Live analysis is paused"));
    const judged = renderToStaticMarkup(<ModeBannerView access={{ lane: "judge", mode: "replay_only", message: null }} />);
    expect(judged).toContain(">Judge lane · Replays only</span>");
  });

  it("draws no banner while live or in economy, or before the access is read", () => {
    expect(renderToStaticMarkup(<ModeBannerView access={{ lane: "public", mode: "live", message: null }} />)).toBe("");
    expect(renderToStaticMarkup(<ModeBannerView access={{ lane: "public", mode: "economy", message: "Live briefs run on the economy analyst." }} />)).toBe("");
    expect(renderToStaticMarkup(<ModeBannerView access={null} />)).toBe("");
  });

  it("prints PLAN §11.6's banner only while the lane is replay only", () => {
    expect(modeBannerText({ mode: "live", message: null })).toBeNull();
    expect(modeBannerText({ mode: "economy", message: "Live briefs run on the economy analyst." })).toBeNull();
    expect(modeBannerText({ mode: "replay_only", message: "Live analysis is paused: today's budget is used up." })).toBe(
      "Live analysis is paused: today's budget is used up. Showing recorded runs on real Qloo data.",
    );
    expect(modeBannerText({ mode: "replay_only", message: null })).toBe("Live analysis is paused. Showing recorded runs on real Qloo data.");
  });

  it("renders nothing until the access is read in the browser", () => {
    expect(renderToStaticMarkup(<ModeStatus />)).toBe("");
    expect(renderToStaticMarkup(<ModeBanner />)).toBe("");
  });
});

describe("the Ask panel's economy and paused states", () => {
  it("names the economy analyst and why, under the estimate", () => {
    const e = entry("Economy");
    const html = render(e.state, e.draft);
    const analyst = section(html, "Analyst");
    expect(analyst).toContain("Economy analyst · Claude Haiku");
    expect(analyst).toContain("today&#x27;s live budget is nearly used");
    expect(html.indexOf('aria-label="Estimated"')).toBeLessThan(html.indexOf('aria-label="Analyst"'));
    // Live readings have no such row; the brief still runs.
    expect(render({ ...e.state, phase: { kind: "ready", question: FIXTURE_QUESTION, preview: { ...FIXTURE_PREVIEW_ECONOMY, mode: "live" }, at: FIXTURE_AT } })).not.toContain(
      'aria-label="Analyst"',
    );
    expect(html).toContain("<span>Run brief</span>");
  });

  it("says the breaker's reason when paused, then that showcases and replays still work, once", () => {
    const e = entry("Paused by a breaker");
    const html = render(e.state, e.draft);
    const service = section(html, "Live analysis");
    expect(service).toContain("Live analysis is paused: today&#x27;s budget is used up");
    expect(service).toContain("It resumes at 00:00 UTC. Showcases and replays still work.");
    expect(html).not.toContain("<span>Run brief</span>");
    expect(pausedExtra("Live analysis is paused. Showcases and replays still work.")).toBeNull();
    expect(pausedExtra("Live analysis is paused: today's budget is used up.")).toBe("Showcases and replays still work.");
  });

  it("explains economy without a note too", () => {
    expect(economyDetail(null)).toBe("Today's live budget is nearly used. Every number is still traced to its request; showcases and replays are unchanged.");
  });

  it("asks for a fresh run when Run brief is chosen over the brief already in hand", () => {
    const have: AskState = { phase: { kind: "ready", question: FIXTURE_QUESTION, preview: FIXTURE_PREVIEW_HAVE, at: FIXTURE_AT }, run: { kind: "idle" } };
    expect(runRequestBody(have)).toEqual({ question: FIXTURE_QUESTION, previewToken: FIXTURE_PREVIEW_HAVE.token, fresh: true });
    const none: AskState = { ...have, phase: { ...have.phase, preview: { ...FIXTURE_PREVIEW_HAVE, alreadyHave: null } } as AskState["phase"] };
    expect(runRequestBody(none)).not.toHaveProperty("fresh");
  });
});
