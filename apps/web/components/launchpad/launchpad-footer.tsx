import { FIXED_DISCLAIMERS } from "@ct/contracts";
import Link from "next/link";
import { ROUTE_LIVE } from "../../lib/routes";
import { cx } from "../ui/cx";
import { TRUST_HREF } from "./links";

/** Where the page's data comes from and what it never holds (ATTRIBUTION.md, D29). */
export const DATA_LINE =
  "Taste data comes from the Qloo API at runtime and is cached privately; none of it is stored in the public repository. Each brief is a snapshot of the data it was written with.";

const FOOTER_LINK = "text-text-2 hover:text-ink hover:underline hover:underline-offset-4";

/**
 * The Launchpad's footer (SPEC §8.1): the fixed disclaimers every note carries, where the data comes
 * from, and the pages that explain the method and the limits. The status line below keeps the short
 * honesty line in view.
 */
export function LaunchpadFooter({ className }: { className?: string }) {
  return (
    <footer className={cx("flex w-full flex-col gap-2 border-t border-line pt-5 text-[12px] leading-[17px] text-dim", className)}>
      <p className="m-0">{FIXED_DISCLAIMERS.join(" ")}</p>
      <p className="m-0">{DATA_LINE}</p>
      <nav aria-label="About" className="flex flex-wrap gap-x-5 gap-y-1 pt-1">
        <Link href={TRUST_HREF} className={FOOTER_LINK}>
          Trust and safety
        </Link>
        {ROUTE_LIVE.method ? (
          <Link href="/method" className={FOOTER_LINK}>
            Method
          </Link>
        ) : null}
        <Link href="/briefs" className={FOOTER_LINK}>
          All briefs
        </Link>
      </nav>
    </footer>
  );
}
