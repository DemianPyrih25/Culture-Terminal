import type { Metadata } from "next";
import { SiteShell } from "../../components/chrome/site-shell";
import { ScreenerView } from "../../components/screener/screener-view";
import { SCREENER_MARKET_OPTIONS } from "../../server/screener/markets";

export const metadata: Metadata = {
  title: "Brand screener · Culture Terminal",
  description: "Rank the brands of a category, or the brands nearest a seed brand, on taste fit, next-gen tilt, metro breadth and popularity. From Qloo taste data; every value opens its request.",
};

/**
 * /screener (PLAN §5.5, §8.1): the form and the screen run in the browser (POST /api/screener behind
 * the human check); ?q= and ?by=brand prefill the form, so a link names a screen without running it.
 */
export default async function ScreenerPage(props: PageProps<"/screener">) {
  const search = await props.searchParams;
  const q = typeof search.q === "string" ? search.q.slice(0, 120) : "";
  const by = search.by === "brand" ? "brand" : "tag";
  return (
    <SiteShell header="inner" active="screener">
      <ScreenerView markets={SCREENER_MARKET_OPTIONS} initial={{ by, query: q }} />
    </SiteShell>
  );
}
