"use client";

import { useEffect, useState } from "react";
import { NEW_QUESTION_HREF } from "../chrome/links";
import { Button, ButtonLink } from "../ui/button";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";

/**
 * The designed 500 (Ledger V4vJ6k): an icon well, "Error 500", the line, what it means for a run in
 * progress, Try again and Go to Ask, and a reference to quote. The reference is the error's digest (the
 * server log's key) when Next gives one; nothing else about the error reaches the page.
 */
export function ErrorCard({
  digest,
  onRetry,
  compact = false,
}: {
  digest?: string;
  onRetry: () => void;
  /** The bare page of global-error: a smaller card. */
  compact?: boolean;
}) {
  const [at, setAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    // The time is read on the client, after hydration, so it never differs from the server's markup.
    setAt(new Date().toISOString().slice(11, 16));
  }, []);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const reference = digest ? `Reference ${digest}` : null;
  return (
    <section
      aria-labelledby="error-title"
      data-error="500"
      className={cx(
        "flex w-full flex-col gap-4 rounded-card border border-line bg-surface",
        compact ? "max-w-[460px] px-7 pt-7 pb-6" : "max-w-[600px] px-12 pt-11 pb-9 max-md:px-6 max-md:pt-8 max-md:pb-6",
      )}
    >
      <span className={cx("flex items-center justify-center rounded-tile bg-danger-soft text-danger", compact ? "size-10" : "size-13")}>
        <Icon name="triangle-alert" size={compact ? 18 : 22} />
      </span>
      <p className="text-[11px] leading-4 font-semibold tracking-[0.08em] text-ink-3 uppercase">Error 500</p>
      <h1 id="error-title" className={cx("font-display text-ink", compact ? "text-[22px] leading-7" : "text-[30px] leading-9 max-md:text-[24px] max-md:leading-8")}>
        Something went wrong on our side.
      </h1>
      <div className={cx("flex flex-col gap-3 text-ink-2", compact ? "type-caption" : "type-body")}>
        <p>This page hit an unexpected error. It wasn&apos;t caused by anything you did.</p>
        <p>If a run was in progress, it keeps going on the server, and its answer appears under Recent when it&apos;s finished.</p>
      </div>
      <div className="flex flex-wrap gap-2.5 pt-3 max-md:flex-col max-md:items-stretch">
        <Button variant="primary" icon="rotate-ccw" trailing={null} onClick={onRetry} className="max-md:justify-center">
          Try again
        </Button>
        <ButtonLink href={NEW_QUESTION_HREF} variant="secondary" trailing={null} className="max-md:justify-center">
          Go to Ask
        </ButtonLink>
      </div>
      {reference ? (
        <p className="flex flex-wrap items-center gap-2 pt-2 type-caption text-ink-3">
          <span className="font-mono text-[11px]">
            {reference}
            {at ? ` · ${at} UTC` : ""}
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-accent hover:underline"
            onClick={() => {
              void navigator.clipboard?.writeText(digest!).then(
                () => setCopied(true),
                () => undefined,
              );
            }}
          >
            <Icon name="copy" size={12} />
            {copied ? "Copied" : "Copy"}
          </button>
        </p>
      ) : null}
    </section>
  );
}
