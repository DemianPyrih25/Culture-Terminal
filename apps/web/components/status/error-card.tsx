"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { NEW_QUESTION_HREF } from "../chrome/links";
import { Button, ButtonLink } from "../ui/button";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";

const noSubscription = () => () => {};
const utcMinute = () => new Date().toISOString().slice(11, 16);
const noTime = () => null;

/**
 * The designed 500 (Ledger V4vJ6k): an icon well, "Error 500", the line, one line on a run in progress, Try again and Go to Ask, and a reference to quote. The reference is the error's digest (the
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
  const [copied, setCopied] = useState(false);
  // The time is read on the client only (null on the server), so it never differs from the server's markup.
  const at = useSyncExternalStore(noSubscription, utcMinute, noTime);
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
        "flex w-full animate-rise flex-col items-center text-center rounded-card border border-line bg-surface shadow-[0_1px_2px_rgba(22,24,29,0.04)]",
        compact ? "max-w-[460px] gap-2.5 px-7 pt-7 pb-6" : "max-w-[600px] gap-[18px] px-12 pt-11 pb-9 max-md:px-6 max-md:pt-8 max-md:pb-6",
      )}
    >
      <span className={cx("flex items-center justify-center rounded-full bg-danger-soft text-danger", compact ? "size-10" : "size-13")}>
        <Icon name="triangle-alert" size={compact ? 18 : 22} />
      </span>
      <p className="font-mono text-[11px] leading-4 tracking-[0.04em] text-ink-3">Error 500</p>
      <h1 id="error-title" className={cx("font-display font-medium tracking-[-0.01em] text-ink", compact ? "text-[22px] leading-7" : "text-[30px] leading-9 max-md:text-[24px] max-md:leading-8")}>
        Something went wrong on our side.
      </h1>
      <p className={cx("max-w-[480px] text-ink-2", compact ? "text-[12px] leading-[18px]" : "text-[15px] leading-6")}>
        A run in progress keeps going and appears under Recent when done.
      </p>
      <div className="flex flex-wrap justify-center gap-2.5 pt-1 max-md:w-full max-md:flex-col max-md:items-stretch">
        <Button variant="primary" icon="rotate-ccw" trailing={null} onClick={onRetry} className="max-md:justify-center">
          Try again
        </Button>
        <ButtonLink href={NEW_QUESTION_HREF} variant="secondary" trailing={null} className="max-md:justify-center">
          Go to Ask
        </ButtonLink>
      </div>
      {reference ? (
        <p className="flex flex-wrap items-center justify-center gap-2 pt-2.5 text-[11px] leading-4 text-ink-2">
          <span className="font-mono text-[11px]">
            {reference}
            {at ? ` · ${at} UTC` : ""}
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1 font-semibold text-accent transition-opacity duration-150 hover:underline active:opacity-70"
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
