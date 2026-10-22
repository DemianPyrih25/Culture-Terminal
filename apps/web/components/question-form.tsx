"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { QUESTION_MAX_CHARS } from "@ct/contracts";
import { startRun } from "@/lib/start-run";

/** Asks a question: POST /api/runs with {question}, then the live run page. */
export function QuestionForm() {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const text = question.trim();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (text === "" || busy) return;
    setBusy(true);
    setMessage(null);
    const outcome = await startRun({ question: text }, { onRetry: setMessage });
    if (outcome.ok) {
      router.push(`/run/${outcome.runId}`);
      return;
    }
    setBusy(false);
    setMessage(outcome.error);
  }

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-3">
      <label htmlFor="question" className="font-mono text-xs tracking-widest text-zinc-500 uppercase">
        Ask a business question
      </label>
      <textarea
        id="question"
        name="question"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        maxLength={QUESTION_MAX_CHARS}
        rows={3}
        placeholder="Is the Liquid Death audience a moat or a niche?"
        className="w-full resize-y rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-base text-zinc-100 placeholder:text-zinc-600 focus:border-amber-400/70 focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy || text === ""}
          className="rounded border border-amber-400/70 bg-amber-400/10 px-5 py-3 font-mono text-sm tracking-wide text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Starting…" : "Run the analysis"}
        </button>
        <span className="font-mono text-xs text-zinc-500">
          {question.length}/{QUESTION_MAX_CHARS}
        </span>
      </div>
      {message ? <p className="font-mono text-xs text-zinc-400">{message}</p> : null}
    </form>
  );
}
