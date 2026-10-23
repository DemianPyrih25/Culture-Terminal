"use client";

import { useSyncExternalStore } from "react";

/** True on Apple platforms, where the shortcut modifier is ⌘; elsewhere it is Ctrl. */
export function isApplePlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

/** A keycap label written with ⌘ (e.g. "⌘K", "⌘↵") for the reader's platform: unchanged on Apple, "Ctrl K" elsewhere. */
export function keycapForPlatform(label: string, apple: boolean): string {
  return apple ? label : label.replace("⌘", "Ctrl ");
}

const noSubscription = () => () => undefined;

/**
 * Whether the reader is on an Apple platform. The server and the first client render say yes, so the
 * markup hydrates as "⌘K"; the real platform swaps in right after.
 */
export function useApplePlatform(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => isApplePlatform(navigator.platform),
    () => true,
  );
}
