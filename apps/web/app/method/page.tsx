import type { Metadata } from "next";
import { METHOD_PAGE } from "../../content/method";
import { MethodView } from "../../components/method/method-view";
import { ReferenceChrome } from "../../components/method/reference";
import { methodFacts, openingScan, qlooEndpoints, trendWindowText } from "./facts";
import { loadEvalSummary } from "./load-eval";

export const metadata: Metadata = {
  title: METHOD_PAGE.metaTitle,
  description: METHOD_PAGE.metaDescription,
};

/**
 * A11 · Method & sources, generated from the code: @ct/quant FORMULAS, the contracts' checker and
 * conviction rules, the agent's scan table and models. Static: the eval summary is read when the page
 * is built, so a new one ships with the next build.
 */
export default function MethodPage() {
  const trendWindow = trendWindowText();
  return (
    <ReferenceChrome active="method" trendWindow={trendWindow}>
      <MethodView
        facts={methodFacts()}
        scan={openingScan()}
        endpoints={qlooEndpoints()}
        trendWindow={trendWindow}
        evaluation={loadEvalSummary()}
      />
    </ReferenceChrome>
  );
}
