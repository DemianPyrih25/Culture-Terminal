import type { Metadata } from "next";
import { NEW_QUESTION_HREF } from "@/components/chrome/links";
import { SiteShell } from "@/components/chrome/site-shell";
import { ButtonLink } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Page not found · Culture Terminal",
  robots: { index: false, follow: false },
};

/** Any URL that matches no page (Ledger Z74OH): the 404 card in the site shell, with the way to ask. */
export default function NotFound() {
  return (
    <SiteShell header="inner" mainClassName="flex flex-col items-center py-24 max-md:py-10">
      <section
        aria-labelledby="missing-title"
        data-missing="no_page"
        className="flex w-full max-w-[560px] flex-col items-start gap-4 rounded-card border border-line bg-surface px-12 pt-11 pb-10 max-md:px-6 max-md:pt-8 max-md:pb-6"
      >
        <span className="flex size-13 items-center justify-center rounded-tile bg-sunken text-ink-3">
          <Icon name="search-x" size={22} />
        </span>
        <p className="text-[11px] leading-4 font-semibold tracking-[0.08em] text-ink-3 uppercase">Error 404</p>
        <h1 id="missing-title" className="font-display text-[30px] leading-9 text-ink max-md:text-[24px] max-md:leading-8">
          There&apos;s no page at this link.
        </h1>
        <p className="type-body text-ink-2">
          The address may have a typo, or the page it pointed to no longer exists. Your briefs and follows are not affected.
        </p>
        <ButtonLink href={NEW_QUESTION_HREF} variant="primary" className="mt-3 max-md:w-full max-md:justify-center" data-missing-action="no_page">
          Ask a question
        </ButtonLink>
      </section>
    </SiteShell>
  );
}
