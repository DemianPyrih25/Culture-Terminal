"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { QUESTION_MAX_CHARS } from "@ct/contracts/values";
import { nextMoveHref, type BriefNextMove } from "../../lib/brief";
import Link from "next/link";
import { Button, Icon } from "../ui";

/**
 * AskNextCard (§2.6 row H): the run's own next moves as plain links, and a follow-up field. Both open Ask with
 * the question and this answer as the parent (/ask?q=…&parent=<runId>).
 */
export function AskNextCard({ runId, moves, placeholder }: { runId: string; moves: readonly BriefNextMove[]; placeholder: string }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <h2 id={id} className="font-display text-[20px] leading-7 font-medium text-ink">
        Ask next
      </h2>
      {moves.length > 0 ? (
        <ul className="flex flex-col border-b border-line" data-next-moves={moves.length}>
          {moves.map((m) => (
            <li key={m.question} className="border-t border-line">
              <Link
                href={m.href}
                title={m.question}
                data-next-move={m.label}
                className="group flex min-h-12 items-center gap-3 py-3 text-[15px] leading-6 text-ink hover:text-accent"
              >
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <span className="font-medium">{m.label}</span>
                  {m.question !== m.label ? <span className="text-ink-3"> · {m.question}</span> : null}
                </span>
                <Icon name="arrow-right" size={16} className="shrink-0 text-ink-3 group-hover:text-accent" />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        role="search"
        aria-label="Ask a follow-up"
        className="flex items-center gap-3 rounded-box border border-line-strong bg-surface py-1.5 pr-1.5 pl-4 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--color-accent-soft)] max-md:flex-col max-md:items-stretch max-md:gap-3 max-md:border-0 max-md:bg-transparent max-md:p-0 max-md:focus-within:shadow-none"
        onSubmit={(event) => {
          event.preventDefault();
          const question = value.trim();
          if (question === "") field.current?.focus();
          else router.push(nextMoveHref(question, runId));
        }}
      >
        <input
          ref={field}
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label="Ask a follow-up about this answer"
          placeholder={placeholder}
          maxLength={QUESTION_MAX_CHARS}
          className="h-11 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3 max-md:h-[52px] max-md:flex-none max-md:rounded-box max-md:border max-md:border-line-strong max-md:bg-surface max-md:px-4 max-md:focus:border-accent"
        />
        <Button type="submit" variant="primary" className="max-md:h-[52px] max-md:w-full">
          Ask
        </Button>
      </form>
    </section>
  );
}
