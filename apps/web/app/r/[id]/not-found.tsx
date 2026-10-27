import type { Metadata } from "next";
import { AnswerMissing } from "@/components/working/missing";
import { PendingSwitch } from "./pending";

export const metadata: Metadata = {
  title: "No answer here · Culture Terminal",
  robots: { index: false, follow: false },
};

/** A permalink with no finished answer: the way to its run while it has none yet, else the plain not-found card. */
export default function PermalinkNotFound() {
  return (
    <PendingSwitch>
      <AnswerMissing kind="not_found" />
    </PendingSwitch>
  );
}
