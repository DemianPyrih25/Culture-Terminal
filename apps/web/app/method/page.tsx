import type { Metadata } from "next";
import { SiteShell } from "../../components/chrome/site-shell";
import { MethodView } from "../../components/method/method-view";
import { METHOD_PAGE } from "../../content/method";
import { coverageFacts } from "./coverage";
import { CoverageSection } from "./coverage-section";
import { methodFacts, openingScan, qlooEndpoints, rulesFacts, trendWindowText } from "./facts";
import { loadEvalSummary } from "./load-eval";

export const metadata: Metadata = {
  title: METHOD_PAGE.metaTitle,
  description: METHOD_PAGE.metaDescription,
};

// Rendered per request: the daily caps it states are the running server's configuration.
export const dynamic = "force-dynamic";

/**
 * /method, the analysts' reference: generated from the code (@ct/quant FORMULAS, the contracts' checker
 * and confidence rules, the agent's scan table and models), the coverage configs and the server's
 * caps. The eval summary ships beside the server (next.config.ts outputFileTracingIncludes).
 */
export default function MethodPage() {
  return (
    <SiteShell header="inner" active="how">
      <MethodView
        facts={methodFacts()}
        scan={openingScan()}
        endpoints={qlooEndpoints()}
        trendWindow={trendWindowText()}
        evaluation={loadEvalSummary()}
        rules={rulesFacts()}
      />
      {/* The coverage card sits under the reference column (MethodView takes no extra section yet). */}
      <div className="-mt-6 pb-12 max-md:-mt-4 max-md:pb-8 md:grid md:grid-cols-[200px_minmax(0,1fr)] md:gap-12">
        <div className="max-md:hidden" />
        <CoverageSection facts={coverageFacts()} />
      </div>
    </SiteShell>
  );
}
