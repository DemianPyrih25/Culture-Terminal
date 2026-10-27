import type { Metadata } from "next";
import { AnswerMissing } from "@/components/working/missing";

export const metadata: Metadata = {
  title: "Page not found · Culture Terminal",
  robots: { index: false, follow: false },
};

/** Any URL that matches no page: the N16 "Link not found" card in the site shell, with the way to ask. */
export default function NotFound() {
  return <AnswerMissing kind="no_page" />;
}
