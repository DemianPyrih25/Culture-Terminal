import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SiteShell } from "../../components/chrome/site-shell";
import { desHref, parseDesInput } from "../../components/des/des-href";
import { ProfileStateView } from "../../components/des/profile-states";

export const metadata: Metadata = {
  title: "Look up a profile · Culture Terminal",
  description: "Look up any brand, artist, show or public figure: who its fans are, what else they love, and where their taste travels. From Qloo taste data.",
};

const INVALID = "Type a name with letters or digits, up to 80 characters.";

/**
 * /d: look up a profile. The search box sends GET /d?q=<name>&type=<type>, which opens /d/<name> (with
 * ?type= for anything but a brand), so it works without a script.
 */
export default async function DesSearchPage(props: PageProps<"/d">) {
  const search = await props.searchParams;
  const q = typeof search.q === "string" ? search.q : null;
  const type = typeof search.type === "string" ? search.type : null;
  if (q !== null) {
    const parsed = parseDesInput(q, type);
    if (parsed !== null) redirect(desHref(parsed));
  }
  return (
    <SiteShell header="inner">
      <ProfileStateView query={null} outcome={null} error={q !== null ? INVALID : null} />
    </SiteShell>
  );
}
