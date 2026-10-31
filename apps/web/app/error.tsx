"use client";

import { useEffect } from "react";
import { SiteShell } from "../components/chrome/site-shell";
import { ErrorCard } from "../components/status/error-card";

/**
 * An unexpected server or render error in any page (Ledger V4vJ6k): the site shell and the designed
 * 500 card. retry() re-fetches and re-renders the page; the digest is the reference to quote.
 */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <SiteShell header="inner" mainClassName="flex flex-col items-center gap-5 py-24 max-md:py-10">
      <title>Something went wrong · Culture Terminal</title>
      <ErrorCard digest={error.digest} onRetry={retry} />
      <p className="max-w-[600px] text-center type-caption text-ink-3">Quote the reference if you contact support; it points us to the exact failure.</p>
    </SiteShell>
  );
}
