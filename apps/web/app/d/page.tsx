import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { desHref, parseDesInput } from "@/components/des/des-href";
import { DesChrome } from "@/components/des/des-chrome";
import { DesStateView } from "@/components/des/des-view";

export const metadata: Metadata = {
  title: "DES · Culture Terminal",
  description: "Describe any brand, artist, show or public figure: audience DNA, cultural neighbours and travel taste, computed in code from Qloo.",
};

const INVALID = "Type a name with letters or digits, up to 80 characters.";

/**
 * /d: the tearsheet's search page. The search box sends GET /d?q=<name>&type=<type>, which opens
 * /d/<name> (with ?type= for anything but a brand), so it works without a script.
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
    <DesChrome>
      <DesStateView query={null} outcome={null} error={q !== null ? INVALID : null} />
    </DesChrome>
  );
}
