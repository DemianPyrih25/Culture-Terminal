import type { Metadata } from "next";
import { TRUST_PAGE } from "../../content/trust";
import { ReferenceChrome } from "../../components/method/reference";
import { TrustView } from "../../components/trust/trust-view";
import { trendWindowText } from "../method/facts";
import { trustFacts } from "./facts";

export const metadata: Metadata = {
  title: TRUST_PAGE.metaTitle,
  description: TRUST_PAGE.metaDescription,
};

// Rendered per request: the daily caps it states are the running server's configuration.
export const dynamic = "force-dynamic";

/** /trust: safe use, refusals, the audience allowlist, data handling and the guards (SPEC §6.5). */
export default function TrustPage() {
  return (
    <ReferenceChrome trendWindow={trendWindowText()}>
      <TrustView {...trustFacts()} />
    </ReferenceChrome>
  );
}
