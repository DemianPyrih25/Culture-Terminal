import type { Metadata } from "next";
import { BriefMissing } from "@/components/brief";

export const metadata: Metadata = {
  title: "No brief here · Culture Terminal",
  robots: { index: false, follow: false },
};

/** A run id that does not exist: the styled 404, with the chrome to ask again. */
export default function RunNotFound() {
  return <BriefMissing kind="not_found" />;
}
