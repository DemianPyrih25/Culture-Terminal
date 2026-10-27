import type { Metadata } from "next";
import { SiteShell } from "../../components/chrome/site-shell";
import { HowItWorksView } from "../../components/method/how-it-works-view";
import { HOW_PAGE } from "../../content/how-it-works";
import { trendWindowText } from "../method/facts";

export const metadata: Metadata = {
  title: HOW_PAGE.metaTitle,
  description: HOW_PAGE.metaDescription,
};

/** /how-it-works (N15): how an answer is made and how to read one. Static; the trend window is read from the code. */
export default function HowItWorksPage() {
  return (
    <SiteShell header="inner" active="how">
      <HowItWorksView trendWindow={trendWindowText()} />
    </SiteShell>
  );
}
