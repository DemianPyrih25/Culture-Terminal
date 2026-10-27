import Link from "next/link";
import { cx } from "../ui/cx";
import { HOW_IT_WORKS_HREF } from "./links";

/**
 * C/Footer: not sticky. One centred caption line in ink-2 ending in the accent "How it works"; two lines
 * on phones. The link is underlined: the accent alone is too close to ink-2 to mark a link in text.
 */
export function Footer({ className }: { className?: string }) {
  return (
    <footer className={cx("px-4 pt-6 pb-12 text-center type-caption text-ink-2", className)}>
      <p>
        Group-level taste data from Qloo · No individuals ·<br className="md:hidden" /> Not financial advice ·{" "}
        <Link href={HOW_IT_WORKS_HREF} className="rounded-sm text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
          How it works
        </Link>
      </p>
    </footer>
  );
}
