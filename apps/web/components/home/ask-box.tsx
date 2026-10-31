"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useReducer, useRef, useState, type KeyboardEvent } from "react";
import { rememberRun } from "../../lib/recent-briefs";
import { startRun } from "../../lib/start-run";
import {
  askNotice,
  askReducer,
  askStatusText,
  INITIAL_ASK_STATE,
  isBusy,
  nextStep,
  readPreviewResponse,
  runRequestBody,
  type AccessPause,
  type AskEvent,
  type AskState,
  type PreviewOutcome,
} from "../ask/ask-machine";
import { followsUp, type AskParent } from "../ask/ask-parent";
import { ASK_FIELD_ID } from "../chrome/links";
import { desCommandHref } from "../des/des-href";
import { loadAccess } from "../protection/access-client";
import { HumanCheckPanel, sharedHumanFetch, useHumanCheck, useHumanState } from "../protection/human-check-panel";
import { useAccess } from "../protection/use-access";
import { cx } from "../ui/cx";
import { AskNoticeView } from "./ask-notice";
import { QuestionBox, type QuestionBoxState } from "./question-box";
import { SuggestionList, suggestionOptionId } from "./suggestion-list";
import { moveActive, suggestionRows, suggestionsFor, type Suggestion } from "./suggestions";
import { UnderstoodLine } from "./understood-line";

export interface AskBoxProps {
  /** /ask?q=: sent as soon as the page opens. */
  initialQuestion?: string;
  /** /ask?parent=: the answer this question follows up on. */
  parent?: AskParent | null;
  className?: string;
}

const NOTICE_ID = "ask-notice";

/** The id holder is the field itself: "New question" from any page lands in it (#ask). */
function focusOnAskHash(field: HTMLTextAreaElement | null): void {
  if (field && window.location.hash === `#${ASK_FIELD_ID}`) field.focus();
}

/**
 * Home's ask flow: the question box, its suggestion list, the "Understood as" line once the question
 * is read, and the one inline state under it. "Get answer" reads the question (POST /api/preview) and then, with no confirm step, opens
 * the answer the visitor already has or starts the run (POST /api/runs with the preview's token) and
 * moves to it; the run id is kept in this browser's own answers first. Both requests pass the human
 * check (Turnstile, under the box) through humanFetch. A visitor whose live questions are paused sees
 * the button disabled and the paused state before sending anything.
 */
export function AskBox({ initialQuestion = "", parent: initialParent = null, className }: AskBoxProps) {
  const router = useRouter();
  const listId = useId();
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const preview = useRef<AbortController | null>(null);
  const human = useHumanCheck();
  const humanStatus = useHumanState(human).status;
  const access = useAccess();
  const [text, setText] = useState(initialQuestion);
  const [parent, setParent] = useState(initialParent);
  const [focused, setFocused] = useState(false);
  // A question that arrives in the URL is sent at once: no list over it.
  const [dismissed, setDismissed] = useState(initialQuestion.trim() !== "");
  const [active, setActive] = useState(-1);
  const [state, dispatch] = useReducer(askReducer, initialQuestion.trim(), (question): AskState =>
    question === "" ? INITIAL_ASK_STATE : { phase: { kind: "loading", question }, run: { kind: "idle" } },
  );

  const pause: AccessPause | null = access?.mode === "replay_only" ? { until: access.until, message: access.message } : null;
  const busy = isBusy(state);
  const notice = askNotice(state, pause);
  const groups = busy ? [] : suggestionsFor(text);
  const rows = suggestionRows(groups);
  const open = focused && !dismissed && rows.length > 0;
  const activeRow = open && active >= 0 ? rows[active] : undefined;
  // How the question was read, once it is: shown while the answer starts (never a refused question).
  const understood = state.phase.kind === "ready" && state.phase.preview.refusal === undefined ? state.phase.preview.understood : null;
  const boxState: QuestionBoxState = busy ? "loading" : pause !== null || state.phase.kind === "paused" ? "paused" : "idle";

  async function startAnswer(after: AskState): Promise<void> {
    const body = runRequestBody(after, followsUp(parent) ? parent.runId : null);
    if (body === null) return;
    dispatch({ type: "run" });
    const outcome = await startRun(body, { onRetry: (message) => dispatch({ type: "runRetrying", message }), fetch: sharedHumanFetch() });
    if (!outcome.ok) {
      dispatch({ type: "runFailed", message: outcome.error });
      return;
    }
    rememberRun(outcome.runId);
    router.push(`/run/${outcome.runId}`);
  }

  async function send(question: string): Promise<void> {
    // "<NAME> DES" is a profile, not a run.
    const des = desCommandHref(question);
    if (des !== null) {
      router.push(des);
      return;
    }
    preview.current?.abort();
    const controller = new AbortController();
    preview.current = controller;
    dispatch({ type: "preview", question });
    let outcome: PreviewOutcome;
    try {
      const res = await sharedHumanFetch()("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
      const body: unknown = await res.json().catch(() => null);
      outcome = readPreviewResponse(res.status, body, res.headers.get("retry-after"));
    } catch {
      if (controller.signal.aborted) return;
      outcome = readPreviewResponse(null, null);
    }
    if (controller.signal.aborted) return;
    const event: AskEvent = { type: "previewed", question, outcome, at: Date.now() };
    dispatch(event);
    // Live questions paused since the page read its access: read it again, for the reopen time.
    if (outcome.kind === "paused") void loadAccess(true);
    const after = askReducer({ phase: { kind: "loading", question }, run: { kind: "idle" } }, event);
    const step = nextStep(after);
    if (step.kind === "open") {
      rememberRun(step.runId);
      router.push(`/run/${step.runId}`);
    } else if (step.kind === "run") {
      await startAnswer(after);
    }
  }

  // /ask?q=: the question in the URL is sent on arrival.
  useEffect(() => {
    const question = initialQuestion.trim();
    if (question !== "") void send(question);
    return () => preview.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, []);

  // "New question" from another page arrives as /#ask: the caret goes in the box.
  useEffect(() => {
    const field = fieldRef.current;
    focusOnAskHash(field);
    const onHash = () => focusOnAskHash(fieldRef.current);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function change(value: string): void {
    setText(value);
    setDismissed(false);
    setActive(-1);
    // A new question drops the last one's inline state; a question being read keeps it.
    if (!busy && state.phase.kind !== "idle") dispatch({ type: "clear" });
  }

  /** Get answer, Enter or a reframe: the list closes and the question is sent. */
  function ask(question: string): void {
    setDismissed(true);
    void send(question);
  }

  function pick(row: Suggestion): void {
    setDismissed(true);
    router.push(row.href);
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (!open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((n) => moveActive(n, rows.length, event.key as "ArrowDown" | "ArrowUp"));
    } else if (event.key === "Enter" && !event.shiftKey && activeRow) {
      event.preventDefault();
      pick(activeRow);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
    }
  }

  function dropParent(): void {
    setParent(null);
    const question = text.trim();
    window.history.replaceState(null, "", question === "" ? "/ask" : `/ask?q=${encodeURIComponent(question)}`);
    fieldRef.current?.focus();
  }

  const following = followsUp(parent);
  const follow = following ? { label: parent.question ?? "your last answer", onDrop: dropParent } : null;
  const waitingForCheck = humanStatus === "interactive" || humanStatus === "error";
  return (
    <div className={cx("flex w-full flex-col", className)}>
      <div className="relative w-full">
        <QuestionBox
          id={ASK_FIELD_ID}
          fieldRef={fieldRef}
          value={text}
          onChange={change}
          onSubmit={ask}
          onKeyDown={keyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          state={boxState}
          loadingLabel={state.run.kind === "starting" ? "Starting…" : "Reading…"}
          placeholder={following ? "Ask a follow-up about this answer" : undefined}
          followUp={follow}
          combobox={{ expanded: open, listId, activeId: activeRow ? suggestionOptionId(listId, activeRow.key) : null }}
          describedBy={notice ? NOTICE_ID : undefined}
        />
        {open ? (
          <SuggestionList
            id={listId}
            groups={groups}
            activeKey={activeRow?.key ?? null}
            onPick={pick}
            onHover={(row) => setActive(rows.indexOf(row))}
            className="absolute inset-x-0 top-full z-20 mt-2"
          />
        ) : null}
      </div>
      {understood !== null ? <UnderstoodLine understood={understood} className="mt-4" /> : null}
      {notice ? (
        <AskNoticeView
          id={NOTICE_ID}
          notice={notice}
          className="mt-4"
          onReframe={(question) => {
            setText(question);
            ask(question);
          }}
          onRetry={() => {
            if (state.run.kind === "failed") void startAnswer(state);
            else if (state.phase.kind !== "idle") void send(state.phase.question);
          }}
        />
      ) : null}
      <HumanCheckPanel check={human} className="mt-3" />
      <p role="status" aria-live="polite" className="sr-only">
        {askStatusText(state, notice, waitingForCheck)}
      </p>
    </div>
  );
}
