import type { Metadata } from "next";
import { SiteShell } from "../../../components/chrome/site-shell";
import { DEFAULT_DES_TYPE, desHref, parseDesQuery, type DesQuery } from "../../../components/des/des-href";
import { buildProfile } from "../../../components/des/profile-model";
import { ProfileStateView } from "../../../components/des/profile-states";
import { ProfileView } from "../../../components/des/profile-view";
import { curatedEntity, type CuratedEntity } from "../../../server/des/curated";
import { loadTearsheet } from "./load";

// Rendered per request: the lookup reads the visitor's lane and limits, and the mode as it is now.
export const dynamic = "force-dynamic";

const SITE = "Culture Terminal";
const FALLBACK_TITLE = `Profile · ${SITE}`;
const NOINDEX = { index: false, follow: false } as const;
const INVALID = "That name can't be looked up: use letters or digits, up to 80 characters, and one of the listed types.";

const one = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));
const titleOf = (name: string) => `${name} · Audience profile · ${SITE}`;

/**
 * Whether the address is the curated entity's own, as desHref writes it: the config's spelling, and
 * ?type= only for a type other than brand. Every other spelling of it is a duplicate and stays unlisted.
 */
function atCuratedAddress(query: DesQuery, curated: CuratedEntity, rawType: string): boolean {
  return query.name === curated.name && rawType === (curated.type === DEFAULT_DES_TYPE ? "" : curated.type);
}

/**
 * D31 for profiles: a curated entity's profile, at its own address, is indexed with a description;
 * every other one is a reader's own lookup and carries noindex. Neither waits for the lookup, so a
 * pause, a limit or a slow Qloo answer never takes a curated profile out of the index. A person's name
 * reaches the title only when curated: an unvetted name is refused and never repeated back.
 */
export async function generateMetadata(props: PageProps<"/d/[entity]">): Promise<Metadata> {
  const [{ entity }, search] = await Promise.all([props.params, props.searchParams]);
  const query = parseDesQuery(entity, search);
  if (query === null) return { title: FALLBACK_TITLE, robots: NOINDEX };
  const curated = query.pick === null ? curatedEntity(query.name, query.type) : null;
  const title = query.type === "person" && curated === null ? FALLBACK_TITLE : titleOf(query.name);
  if (curated === null || !atCuratedAddress(query, curated, one(search.type))) return { title, robots: NOINDEX };
  return {
    title: titleOf(curated.name),
    description: `${curated.name}: who its fans are, what else they love, and where their taste travels. From Qloo taste data, every number traced.`,
    // Its own address is the one indexed; the root layout's metadataBase makes it absolute.
    alternates: { canonical: desHref(curated) },
  };
}

/**
 * /d/[entity]: the audience profile (N14, SPEC D11, "<NAME> DES"). Code only, no AI model: the name is
 * matched exactly, then who the fans are, what else they love and where their taste travels are read
 * from Qloo. A name that needs a pick, has no match, is a private person, or arrives while profiles are
 * paused or limited gets its own card and the search box.
 */
export default async function DesPage(props: PageProps<"/d/[entity]">) {
  const [{ entity }, search] = await Promise.all([props.params, props.searchParams]);
  const query = parseDesQuery(entity, search);
  if (query === null) {
    return (
      <SiteShell header="inner">
        <ProfileStateView query={null} outcome={null} error={INVALID} />
      </SiteShell>
    );
  }
  const outcome = await loadTearsheet(query.name, query.type, query.pick);
  return (
    <SiteShell header="inner">
      {outcome.kind === "ready" ? (
        <ProfileView profile={buildProfile(outcome.sheet, outcome.cachedAt)} />
      ) : (
        <ProfileStateView query={query} outcome={outcome} />
      )}
    </SiteShell>
  );
}
