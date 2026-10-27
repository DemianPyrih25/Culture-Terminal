import type { Metadata } from "next";
import { AnswerMissing } from "@/components/working/missing";

export const metadata: Metadata = {
  title: "No answer here · Culture Terminal",
  robots: { index: false, follow: false },
};

/** A run id that does not exist: one line and the way to ask. */
export default function RunNotFound() {
  return <AnswerMissing kind="not_found" />;
}
