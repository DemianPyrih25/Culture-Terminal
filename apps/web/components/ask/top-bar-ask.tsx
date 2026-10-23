"use client";

import type { ShortcutKey } from "../ui/shortcut";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CommandField } from "../ui";
import { askHref } from "./ask-href";

export interface TopBarAskProps {
  /** The brief a question asked here follows up on (a child run, PLAN §7.3); null on other pages. */
  parentRunId?: string | null;
  placeholder?: string;
  /** The global keys that focus the field (CommandField's `shortcut`); default true. */
  shortcut?: boolean | readonly ShortcutKey[];
}

/**
 * The top bar's question field (A/Command field). Submitting opens the Ask page (A02), where the
 * question is previewed ("Understood as") before a brief runs; on a brief it carries the parent run,
 * which the Ask page shows as "Following up on" and the run records as its parent. The field empties
 * once the question is on its way.
 */
export function TopBarAsk({ parentRunId = null, placeholder, shortcut = true }: TopBarAskProps) {
  const router = useRouter();
  const [value, setValue] = useState("");
  return (
    <CommandField
      value={value}
      onChange={setValue}
      shortcut={shortcut}
      placeholder={placeholder ?? (parentRunId ? "Ask a follow-up on this brief" : "Ask a question")}
      onSubmit={(question) => {
        setValue("");
        router.push(askHref(question, parentRunId));
      }}
    />
  );
}
