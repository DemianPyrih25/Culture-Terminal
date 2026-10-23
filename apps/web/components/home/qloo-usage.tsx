/** "Qloo 214 / 1,900 req today": fresh Qloo requests today against the day's quota. */
export function qlooUsageText(used: number, cap: number): string {
  return `Qloo ${used.toLocaleString("en-US")} / ${cap.toLocaleString("en-US")} req today`;
}

/** The part of the server's Qloo client the count reads (@ct/qloo is imported in server/ only). */
export interface QlooQuotaSource {
  quota(): { todayNetwork: number };
}

/**
 * Today's fresh Qloo requests, read on the server while the page renders (the container's peekQlooClient
 * and getQlooClient). Null when the client cannot be configured (live Qloo without a key), or when this
 * read is what creates it: a new client is still loading the day's count from the database, and its 0
 * would be wrong. The next page shows the count.
 */
export function qlooRequestsToday(peek: () => QlooQuotaSource | undefined, get: () => QlooQuotaSource): number | null {
  const loaded = peek() !== undefined;
  try {
    const used = get().quota().todayNetwork;
    return loaded ? used : null;
  } catch {
    return null;
  }
}

export interface QlooUsageProps {
  /** Today's fresh requests (qlooRequestsToday); null prints nothing. */
  used: number | null;
  /** The day's fresh-request quota (QLOO_DAILY_FRESH_CAP). */
  cap: number;
}

/** The status line's request count, as the server read it; nothing when it could not say. */
export function QlooUsage({ used, cap }: QlooUsageProps) {
  if (used === null) return null;
  return <span className="font-mono">{qlooUsageText(used, cap)}</span>;
}
