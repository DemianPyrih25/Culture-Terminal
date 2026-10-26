"use client";

import type { Lane, Mode } from "@ct/contracts";
import { useEffect, useSyncExternalStore } from "react";
import { PAGE_GUTTER } from "../layout/grid";
import { cx } from "../ui/cx";
import { ACCESS_TTL_MS, accessStore, type Access } from "./access-client";

const noAccess = (): Access | null => null;

/**
 * The visitor's access (GET /api/access); null until read, or when it cannot be. Read on mount, and
 * again while the page stays open and visible once the last read is ACCESS_TTL_MS old, so a mode
 * that changes under a page that persists across navigations (the top bar) is seen.
 */
export function useAccess(): Access | null {
  const access = useSyncExternalStore(accessStore.subscribe, accessStore.getSnapshot, noAccess);
  useEffect(() => {
    void accessStore.load();
    const refresh = () => {
      if (document.visibilityState === "visible") void accessStore.load();
    };
    const timer = setInterval(refresh, ACCESS_TTL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return access;
}

const MODE_TEXT: Readonly<Record<Mode, string>> = {
  live: "Live analysis",
  economy: "Economy analysis",
  replay_only: "Replays only",
};

/** The same, short enough to sit beside the honesty line on a phone. */
const MODE_SHORT: Readonly<Record<Mode, string>> = {
  live: "Live",
  economy: "Economy",
  replay_only: "Replays only",
};

/**
 * The status line's word on the mode: "Economy analysis", "Judge lane · Replays only"; `short` for the
 * phone strip: "Economy", "Judge · Replays only". Null in live mode, on either lane: there is nothing
 * to say.
 */
export function modeStatusText(lane: Lane, mode: Mode, short = false): string | null {
  if (mode === "live") return null;
  const text = (short ? MODE_SHORT : MODE_TEXT)[mode];
  return lane === "judge" ? `${short ? "Judge" : "Judge lane"} · ${text}` : text;
}

type ModeAccess = Pick<Access, "lane" | "mode" | "message">;

export interface ModeStatusProps {
  /** The short words, for the phone strip. */
  short?: boolean;
  className?: string;
}

/** The status line's mode for this access: a 6 px accent square and the word on it; nothing in live mode. */
export function ModeStatusView({ access, short = false, className }: ModeStatusProps & { access: ModeAccess | null }) {
  const text = access === null || access.mode === null ? null : modeStatusText(access.lane, access.mode, short);
  if (text === null || access === null) return null;
  return (
    <span
      data-mode-status={access.mode}
      className={cx("inline-flex items-center gap-1.5 font-medium whitespace-nowrap text-ink", className)}
      title={access.message ?? undefined}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 bg-accent" />
      {text}
    </span>
  );
}

/** The status line's mode, as GET /api/access says it; nothing until it is read, and nothing while live. */
export function ModeStatus({ short, className }: ModeStatusProps) {
  return <ModeStatusView access={useAccess()} short={short} className={className} />;
}

/**
 * PLAN §11.6's replay-only banner: "Live analysis is paused: <reason>. Showing recorded runs on real
 * Qloo data." Null while live analysis runs (economy says so in the status line and the Ask panel).
 */
export function modeBannerText(access: Pick<Access, "mode" | "message">): string | null {
  if (access.mode !== "replay_only") return null;
  const paused = (access.message ?? "Live analysis is paused.").trim();
  return `${paused} Showing recorded runs on real Qloo data.`;
}

/**
 * The banner under the top bar for this access: on canvas under a hairline, in the page gutter, the
 * REPLAYS ONLY marker (accent on accent-soft, mono, like the REPLAY marker) and the sentence. Nothing
 * unless the lane is replay only; never printed.
 */
export function ModeBannerView({ access, className }: { access: ModeAccess | null; className?: string }) {
  const text = access === null ? null : modeBannerText(access);
  if (text === null || access === null) return null;
  return (
    <div role="status" data-mode-banner={access.mode} className={cx("w-full border-b border-line bg-canvas py-2 print:hidden", PAGE_GUTTER, className)}>
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-4 text-text-2">
        <span className="inline-flex h-[18px] shrink-0 items-center rounded-brief bg-accent-soft px-1.5 font-mono text-[10px] leading-none font-medium tracking-[1px] text-accent uppercase">
          {access.lane === "judge" ? "Judge lane · Replays only" : "Replays only"}
        </span>
        <span className="min-w-0">{text}</span>
      </p>
    </div>
  );
}

/** The banner under the top bar while the visitor's lane is replay only. */
export function ModeBanner({ className }: { className?: string }) {
  return <ModeBannerView access={useAccess()} className={className} />;
}
