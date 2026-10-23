"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { askHref } from "../ask/ask-href";
import { QuestionField } from "../ask/question-field";

/** Home's A/Question field: Enter opens the Ask page, where the question is read before it runs. */
export function HomeAsk() {
  const router = useRouter();
  const [value, setValue] = useState("");
  return <QuestionField value={value} onChange={setValue} onSubmit={(question) => router.push(askHref(question))} />;
}
