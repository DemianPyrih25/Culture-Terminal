import type { Metadata } from "next";
import { NEW_QUESTION_HREF } from "@/components/chrome/links";
import { SiteShell } from "@/components/chrome/site-shell";
import { RequestedPath } from "@/components/status/requested-path";
import { ButtonLink } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Page not found · Culture Terminal",
  robots: { index: false, follow: false },
};

/** Any URL that matches no page (Ledger Z74OH): the centred 404 card in the site shell, with the way to ask. */
export default function NotFound() {
  return (
    <SiteShell header="inner" mainClassName="flex flex-col items-center gap-5 py-24 max-md:py-10">
      <section
        aria-labelledby="missing-title"
        data-missing="no_page"
        className="flex w-full max-w-[560px] flex-col items-center gap-[18px] rounded-card border border-line bg-surface px-12 pt-11 pb-10 text-center shadow-[0_1px_2px_rgba(22,24,29,0.04)] max-md:px-6 max-md:pt-8 max-md:pb-6"
      >
        <span className="flex size-13 items-center justify-center rounded-full bg-sunken text-ink-2">
          <Icon name="search-x" size={22} />
        </span>
        <p className="font-mono text-[11px] leading-4 tracking-[0.04em] text-ink-3">Error 404</p>
        <h1
          id="missing-title"
          className="font-display text-[30px] leading-9 font-medium tracking-[-0.01em] text-ink max-md:text-[24px] max-md:leading-8"
        >
          There&apos;s no page at this link.
        </h1>
        <p className="max-w-[440px] text-[15px] leading-6 text-ink-2">
          The address may have a typo, or the page it pointed to no longer exists. Your answers, follows and screens are
          not affected.
        </p>
        <RequestedPath />
        <ButtonLink href={NEW_QUESTION_HREF} variant="primary" className="mt-1.5 max-md:w-full max-md:justify-center" data-missing-action="no_page">
          Ask a question
        </ButtonLink>
      </section>
      <p className="font-mono text-[11px] leading-4 text-ink-3">Page not found · Culture Terminal</p>
    </SiteShell>
  );
}
