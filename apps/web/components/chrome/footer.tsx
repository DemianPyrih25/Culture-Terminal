import Link from "next/link";
import { cx } from "../ui/cx";
import { HOW_IT_WORKS_HREF } from "./links";

/**
 * C/Footer: not sticky. One quiet caption line in ink-2 under the page, ending in "How it works"; two
 * lines on phones. The link is underlined so it reads as a link in text.
 */
export function Footer({ className }: { className?: string }) {
  return (
    <footer className={cx("px-4 pt-10 pb-10 text-center type-caption text-ink-2", className)}>
      <p>
        Group-level taste data from Qloo · No individuals ·<br className="md:hidden" /> Not financial advice ·{" "}
        <Link href={HOW_IT_WORKS_HREF} className="rounded-sm text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink hover:decoration-ink-3">
          How it works
        </Link>
      </p>
    </footer>
  );
}
