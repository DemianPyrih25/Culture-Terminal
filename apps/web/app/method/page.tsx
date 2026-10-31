import type { Metadata } from "next";
import { SiteShell } from "../../components/chrome/site-shell";
import { MethodView } from "../../components/method/method-view";
import { METHOD_PAGE } from "../../content/method";
import { COSTS_COPY, COSTS_SECTION_ID, CostSection } from "./cost-section";
import { costFacts, loadMeasuredCosts } from "./costs";
import { coverageFacts } from "./coverage";
import { COVERAGE_COPY, COVERAGE_SECTION_ID, CoverageSection } from "./coverage-section";
import { methodFacts, openingScan, qlooEndpoints, rulesFacts, trendWindowText } from "./facts";
import { loadEvalSummary } from "./load-eval";

export const metadata: Metadata = {
  title: METHOD_PAGE.metaTitle,
  description: METHOD_PAGE.metaDescription,
};

// Rendered per request: the daily caps it states are the running server's configuration, and the measured
// costs are this server's own live runs.
export const dynamic = "force-dynamic";

/**
 * /method, the analysts' reference: generated from the code (@ct/quant FORMULAS, the contracts' checker
 * and confidence rules, the agent's scan table and models), the coverage configs and the server's
 * caps, and each feature's and job's cost per use. The eval summary ships beside the server
 * (next.config.ts outputFileTracingIncludes).
 */
export default async function MethodPage() {
  const costs = costFacts(await loadMeasuredCosts());
  return (
    <SiteShell header="inner" active="how">
      <MethodView
        facts={methodFacts()}
        scan={openingScan()}
        endpoints={qlooEndpoints()}
        trendWindow={trendWindowText()}
        evaluation={loadEvalSummary()}
        rules={rulesFacts()}
        appendix={[
          { id: COVERAGE_SECTION_ID, label: COVERAGE_COPY.title },
          { id: COSTS_SECTION_ID, label: COSTS_COPY.title },
        ]}
      />
      {/* The coverage and cost cards sit under the reference column, in its index. */}
      <div className="-mt-2 pb-16 max-md:-mt-2 max-md:pb-8 md:grid md:grid-cols-[216px_minmax(0,1fr)] md:gap-14">
        <div className="max-md:hidden" />
        <div className="flex min-w-0 max-w-[880px] flex-col gap-10 max-md:gap-6">
          <CoverageSection facts={coverageFacts()} />
          <CostSection facts={costs} />
        </div>
      </div>
    </SiteShell>
  );
}
