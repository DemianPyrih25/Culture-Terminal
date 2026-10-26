import type { Metadata } from "next";
import { DEFAULT_DES_TYPE, desHref, parseDesQuery, type DesQuery } from "@/components/des/des-href";
import { DesChrome } from "@/components/des/des-chrome";
import { DesStateView, TearsheetView } from "@/components/des/des-view";
import { curatedEntity, isCurated, type CuratedEntity } from "@/server/des/curated";
import { loadTearsheet } from "./load";

// Rendered per request: the lookup reads the visitor's lane and limits, and the mode as it is now.
export const dynamic = "force-dynamic";

const SITE = "Culture Terminal";
const NOINDEX = { index: false, follow: false } as const;
const INVALID = "That name cannot be looked up: use letters or digits, up to 80 characters, and one of the listed types.";

const one = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));

/**
 * Whether the address is the curated entity's own, as desHref writes it: the config's spelling, and
 * ?type= only for a type other than brand. Every other spelling of it is a duplicate and stays unlisted.
 */
function atCuratedAddress(query: DesQuery, curated: CuratedEntity, rawType: string): boolean {
  return query.name === curated.name && rawType === (curated.type === DEFAULT_DES_TYPE ? "" : curated.type);
}

/**
 * D31 for tearsheets: a curated entity's tearsheet, at its own address, is indexed with a description;
 * every other one is a reader's own lookup and carries noindex. Neither waits for the lookup, so a
 * pause, a limit or a slow Qloo answer never takes a curated tearsheet out of the index. A person's
 * name reaches the title only when curated: an unvetted name is refused and never repeated back.
 */
export async function generateMetadata(props: PageProps<"/d/[entity]">): Promise<Metadata> {
  const [{ entity }, search] = await Promise.all([props.params, props.searchParams]);
  const query = parseDesQuery(entity, search);
  if (query === null) return { title: `Tearsheet · ${SITE}`, robots: NOINDEX };
  const curated = query.pick === null ? curatedEntity(query.name, query.type) : null;
  const title = query.type === "person" && curated === null ? `Tearsheet · ${SITE}` : `${query.name} · DES · ${SITE}`;
  if (curated === null || !atCuratedAddress(query, curated, one(search.type))) return { title, robots: NOINDEX };
  return {
    title: `${curated.name} · DES · ${SITE}`,
    description: `${curated.name}: audience DNA, cultural neighbours and travel taste, computed in code from Qloo taste data with every number traced to its request.`,
    // Its own address is the one indexed; the root layout's metadataBase makes it absolute.
    alternates: { canonical: desHref(curated) },
  };
}

/**
 * /d/[entity]: the DES tearsheet (P1 #1, SPEC D11, "<NAME> DES"). Code only, $0 LLM: the name is
 * resolved exactly, then Audience DNA, the cultural neighbourhood and travel taste are read from Qloo
 * and drawn with the brief's figure families. A name that needs a pick, has no match, is a private
 * person, or arrives while tearsheets are paused or limited gets its own card and the search box.
 */
export default async function DesPage(props: PageProps<"/d/[entity]">) {
  const [{ entity }, search] = await Promise.all([props.params, props.searchParams]);
  const query = parseDesQuery(entity, search);
  if (query === null) {
    return (
      <DesChrome>
        <DesStateView query={null} outcome={null} error={INVALID} />
      </DesChrome>
    );
  }
  const outcome = await loadTearsheet(query.name, query.type, query.pick);
  if (outcome.kind !== "ready") {
    return (
      <DesChrome>
        <DesStateView query={query} outcome={outcome} />
      </DesChrome>
    );
  }
  return (
    <DesChrome requests={outcome.sheet.requests}>
      <TearsheetView sheet={outcome.sheet} cachedAt={outcome.cachedAt} curated={query.pick === null && isCurated(query.name, query.type)} />
    </DesChrome>
  );
}
