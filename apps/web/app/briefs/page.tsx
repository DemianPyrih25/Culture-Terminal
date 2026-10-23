import type { Metadata } from "next";
import { AppChrome } from "../../components/home/app-chrome";
import { qlooRequestsToday } from "../../components/home/qloo-usage";
import { libraryHref, readLibraryParams } from "../../components/library/library-params";
import { LibraryView } from "../../components/library/library-view";
import { qlooDailyFreshCapFromEnv } from "../../server/config";
import { getQlooClient, peekQlooClient } from "../../server/container";

export const metadata: Metadata = {
  title: "Briefs · Culture Terminal",
};

/** A09, the briefs library: /briefs?q=&sort=date|conviction&desk=. */
export default async function BriefsPage(props: PageProps<"/briefs">) {
  const params = readLibraryParams(await props.searchParams);
  return (
    <AppChrome active="briefs" qlooCap={qlooDailyFreshCapFromEnv()} qlooUsed={qlooRequestsToday(peekQlooClient, getQlooClient)}>
      {/* A link to another view (a desk, the top bar's Briefs) starts the list over. */}
      <LibraryView key={libraryHref(params)} initial={params} />
    </AppChrome>
  );
}
