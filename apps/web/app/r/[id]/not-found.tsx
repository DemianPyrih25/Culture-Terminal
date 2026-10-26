import type { Metadata } from "next";
import { BriefMissing } from "@/components/brief";
import { PendingSwitch } from "./pending";

export const metadata: Metadata = {
  title: "No brief here · Culture Terminal",
  robots: { index: false, follow: false },
};

/** A permalink with no finished brief: the run's way to /run/[id] while it has no brief yet, else the styled 404. */
export default function PermalinkNotFound() {
  return (
    <PendingSwitch>
      <BriefMissing kind="not_found" />
    </PendingSwitch>
  );
}
