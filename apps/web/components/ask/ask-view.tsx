"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useReducer, useRef, useState } from "react";
import { parseCommand } from "../../lib/grammar/parse";
import { rememberRun } from "../../lib/recent-briefs";
import { startRun } from "../../lib/start-run";
import { askHref, askQuestionOf } from "./ask-href";
import { AskComposer } from "./ask-composer";
import {
  alreadyHaveOfPhase,
  askReducer,
  canRun,
  INITIAL_ASK_STATE,
  phaseQuestion,
  readPreviewResponse,
  runRequestBody,
  type AskState,
  type PreviewOutcome,
} from "./ask-machine";
import { followsUp, type AskParent } from "./ask-panel";
import type { QuestionFieldHandle } from "./question-field";

export interface AskViewProps {
  /** ?q=: read as soon as the page opens. */
  initialQuestion: string;
  /** ?parent=: the brief this question follows up on. */
  parent: AskParent | null;
}

/**
 * The Ask page (A02), live: the question is previewed on arrival (POST /api/preview), edited and
 * previewed again on Enter, and run with the preview's token (POST /api/runs). The run id is kept in
 * this browser's recent briefs before the page moves to the run. The URL follows the question without
 * a navigation, and a navigation to another ?q= (the top bar) is read like a new arrival.
 */
export function AskView({ initialQuestion, parent: initialParent }: AskViewProps) {
  const router = useRouter();
  const urlQuestion = askQuestionOf(useSearchParams().get("q"));
  const fieldRef = useRef<QuestionFieldHandle>(null);
  const preview = useRef<AbortController | null>(null);
  // The ?q= this page last wrote or read: any other is a navigation to read.
  const shown = useRef(initialQuestion.trim());
  const [text, setText] = useState(initialQuestion);
  const [parent, setParent] = useState(initialParent);
  const [state, dispatch] = useReducer(askReducer, initialQuestion.trim(), (question): AskState =>
    question === "" ? INITIAL_ASK_STATE : { phase: { kind: "loading", question }, run: { kind: "idle" } },
  );

  /** The Ask page's own URL for a question and parent, kept in step without a navigation. */
  function replaceUrl(question: string, to: AskParent | null): void {
    shown.current = question;
    const href = question === "" ? (to ? `/ask?parent=${encodeURIComponent(to.runId)}` : "/ask") : askHref(question, to?.runId);
    window.history.replaceState(null, "", href);
  }

  async function requestPreview(question: string): Promise<void> {
    preview.current?.abort();
    const controller = new AbortController();
    preview.current = controller;
    dispatch({ type: "preview", question });
    let outcome: PreviewOutcome;
    try {
      const res = await fetch("/api/preview", {
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
    dispatch({ type: "previewed", question, outcome, at: Date.now() });
  }

  function clear(): void {
    preview.current?.abort();
    dispatch({ type: "clear" });
  }

  // The question in the URL is read on arrival.
  useEffect(() => {
    const question = initialQuestion.trim();
    if (question !== "") void requestPreview(question);
    return () => preview.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, []);

  // A navigation to another ?q= with the same parent keeps this page mounted: read it as a new arrival.
  useEffect(() => {
    if (urlQuestion === shown.current) return;
    shown.current = urlQuestion;
    setText(urlQuestion);
    if (urlQuestion === "") clear();
    else void requestPreview(urlQuestion);
  }, [urlQuestion]);

  async function runBrief(): Promise<void> {
    const body = runRequestBody(state, followsUp(parent) ? (parent?.runId ?? null) : null);
    if (body === null) return;
    dispatch({ type: "run" });
    const outcome = await startRun(body, { onRetry: (message) => dispatch({ type: "runRetrying", message }) });
    if (!outcome.ok) {
      dispatch({ type: "runFailed", message: outcome.error });
      return;
    }
    rememberRun(outcome.runId);
    dispatch({ type: "runStarted" });
    router.push(`/run/${outcome.runId}`);
  }

  function submit(question: string): void {
    const { phase } = state;
    if (question !== phaseQuestion(phase)) {
      replaceUrl(question, parent);
      void requestPreview(question);
    } else if (canRun(state)) {
      void runBrief();
    } else if (phase.kind === "error" || phase.kind === "paused") {
      // Enter on a question that could not be read tries again.
      void requestPreview(question);
    }
  }

  function ask(question: string): void {
    setText(question);
    replaceUrl(question, parent);
    void requestPreview(question);
  }

  // ⌘↵ opens the brief that answers the question read, never a draft's.
  const existing = text.trim() === phaseQuestion(state.phase) ? alreadyHaveOfPhase(state.phase) : null;
  return (
    <AskComposer
      value={text}
      onChange={setText}
      onSubmit={submit}
      onClear={() => {
        clear();
        replaceUrl("", parent);
      }}
      onOpenExisting={existing ? () => router.push(`/run/${existing.runId}`) : undefined}
      state={state}
      compiled={parseCommand(text)}
      parent={parent}
      onEdit={() => fieldRef.current?.focusEnd()}
      onRun={() => void runBrief()}
      onRetry={() => {
        const question = phaseQuestion(state.phase);
        if (question !== null) void requestPreview(question);
      }}
      onAsk={ask}
      onDropParent={() => {
        setParent(null);
        replaceUrl(phaseQuestion(state.phase) ?? text.trim(), null);
        fieldRef.current?.focusEnd();
      }}
      autoFocus
      fieldRef={fieldRef}
    />
  );
}
