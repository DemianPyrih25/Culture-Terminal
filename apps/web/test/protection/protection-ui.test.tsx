// What the protection layer shows: the human check's card and the question box's paused state, rendered
// to markup from fixtures. The Turnstile widget itself is never rendered here (it loads Cloudflare's
// script). Invented entities only.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { askNotice, askStatusText, STILL_OPEN, type AskState } from "../../components/ask/ask-machine";
import { FIXTURE_AT, FIXTURE_PAUSE, FIXTURE_PAUSED_MESSAGE, FIXTURE_QUESTION } from "../../components/ask/fixtures";
import { AskNoticeView } from "../../components/home/ask-notice";
import { HumanCheck, SCRIPT_ERROR, UNSUPPORTED_ERROR } from "../../components/protection/human-check";
import { HumanCheckCard, HumanCheckPanel, humanCheckCopy } from "../../components/protection/human-check-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe("the human check's card", () => {
  it("says nothing while the check runs unseen, and asks the visitor when Cloudflare needs a click", () => {
    expect(humanCheckCopy({ status: "checking" })).toBeNull();
    const unseen = renderToStaticMarkup(
      <HumanCheckCard status="checking" className="mt-3">
        <div id="widget" />
      </HumanCheckCard>,
    );
    expect(unseen).toContain('aria-hidden="true"');
    expect(unseen).toContain('class="h-0 overflow-hidden"');
    expect(unseen).toContain('<div id="widget"></div>');

    const asking = renderToStaticMarkup(<HumanCheckCard status="interactive" className="mt-3" />);
    expect(asking).toContain('aria-label="Human check"');
    expect(asking).toContain("bg-sunken");
    expect(asking).toContain("mt-3");
    expect(asking).toContain("Confirm you&#x27;re a person to get a new answer");
    expect(asking).toContain("Answers you already have need no check.");
    expect(asking).not.toContain("Try again");
    expect(asking).not.toMatch(/showcase|replay/i);
    // Announced politely, for a screen reader whose focus stays in the question box.
    expect(asking).toMatch(/<div class="[^"]*" role="status"><p[^>]*>Confirm you&#x27;re a person/);
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
      detail: "Something in this browser or network blocked Cloudflare's check. New answers need it; answers you already have still open.",
    });
    expect(humanCheckCopy({ status: "error", error: UNSUPPORTED_ERROR })?.head).toBe("This browser cannot run the check that you are a person");
    expect(humanCheckCopy({ status: "error", error: "110200" })?.head).toBe("The check that you are a person could not run");
    const blocked = renderToStaticMarkup(<HumanCheckCard status="error" error={SCRIPT_ERROR} onRetry={() => undefined} />);
    expect(blocked).toContain("could not load");
    expect(blocked).toContain("Try again");
    // The panel offers no Try again where it cannot help.
    expect(renderToStaticMarkup(<HumanCheckCard status="error" error={UNSUPPORTED_ERROR} />)).not.toContain("Try again");
  });

  it("tells the box's live region that the reading waits for the check", () => {
    const loading: AskState = { phase: { kind: "loading", question: FIXTURE_QUESTION }, run: { kind: "idle" } };
    expect(askStatusText(loading, null, true)).toBe("Waiting for the check below the question.");
    expect(askStatusText(loading, null)).toBe("Reading your question…");
  });

  it("renders nothing on the server: the widget waits for the browser to read its access", () => {
    expect(renderToStaticMarkup(<HumanCheckPanel check={new HumanCheck(async () => null)} />)).toBe("");
  });
});

describe("the question box while live questions are paused", () => {
  it("says when new questions reopen, and links to the visitor's own answers", () => {
    const idle: AskState = { phase: { kind: "idle" }, run: { kind: "idle" } };
    const notice = askNotice(idle, FIXTURE_PAUSE, "UTC");
    expect(notice).toEqual({ kind: "paused", text: `New questions reopen at 8:00 pm your time. ${STILL_OPEN}` });
    const html = renderToStaticMarkup(<AskNoticeView notice={notice!} />);
    expect(html).toContain('data-notice="paused"');
    expect(html).toContain('href="/briefs"');
    expect(html).not.toMatch(/showcase|replay|example/i);
  });

  it("says the breaker's reason when a preview answers 503 without a reopen time", () => {
    const paused: AskState = {
      phase: { kind: "paused", question: FIXTURE_QUESTION, message: FIXTURE_PAUSED_MESSAGE, alreadyHave: null, at: FIXTURE_AT },
      run: { kind: "idle" },
    };
    expect(askNotice(paused)?.text).toBe(`${FIXTURE_PAUSED_MESSAGE} ${STILL_OPEN}`);
  });
});
