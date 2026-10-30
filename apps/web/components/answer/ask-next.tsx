"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { QUESTION_MAX_CHARS } from "@ct/contracts/values";
import { nextMoveHref, type BriefNextMove } from "../../lib/brief";
import { Button, Card, CardTitle, ChipLink } from "../ui";

/**
 * AskNextCard (§2.6 row H): the run's own next moves as chips, and a follow-up field. Both open Ask with
 * the question and this answer as the parent (/ask?q=…&parent=<runId>).
 */
export function AskNextCard({ runId, moves, placeholder }: { runId: string; moves: readonly BriefNextMove[]; placeholder: string }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  return (
    <Card aria-labelledby={id} className="flex flex-col">
      <CardTitle id={id}>Ask next</CardTitle>
      {moves.length > 0 ? (
        <ul className="mb-4 flex flex-wrap gap-3 max-md:gap-2" data-next-moves={moves.length}>
          {moves.map((m) => (
            <li key={m.question} className="max-w-full">
              <ChipLink href={m.href} title={m.question} data-next-move={m.label} className="max-w-full" wrap>
                {m.label}
              </ChipLink>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        role="search"
        aria-label="Ask a follow-up"
        className="flex items-center gap-3 rounded-[14px] border-[1.5px] border-line-strong bg-surface py-1.5 pr-1.5 pl-5 focus-within:border-accent focus-within:shadow-[0_0_0_4px_var(--color-accent-soft)] max-md:flex-col max-md:items-stretch max-md:gap-3 max-md:border-0 max-md:p-0 max-md:focus-within:shadow-none"
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
          className="h-11 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3 max-md:h-[52px] max-md:flex-none max-md:rounded-[14px] max-md:border-[1.5px] max-md:border-line-strong max-md:px-4 max-md:focus:border-accent"
        />
        <Button type="submit" variant="primary" className="max-md:h-[52px] max-md:w-full">
          Ask
        </Button>
      </form>
    </Card>
  );
}
