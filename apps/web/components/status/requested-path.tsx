"use client";

import { usePathname } from "next/navigation";

/** "You asked for /the/path" on the 404 card (Ledger Z74OH), read on the client from the address. */
export function RequestedPath() {
  const path = usePathname();
  if (!path) return null;
  return (
    <p className="inline-flex max-w-full items-center gap-2 rounded-control border border-line bg-sunken px-2.5 py-1.5 text-[12px] leading-4">
      <span className="shrink-0 text-ink-2">You asked for</span>
      <span className="truncate font-mono text-ink">{path}</span>
    </p>
  );
}
