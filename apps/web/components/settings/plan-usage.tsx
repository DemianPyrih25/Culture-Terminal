"use client";

import { useEffect, useState } from "react";
import { useFollows } from "../following/follow-button";
import { useAccess } from "../protection/use-access";
import { cx } from "../ui/cx";
import { laneName, serviceView, type ServiceView } from "./plan-facts";
import { SETTINGS_LABEL } from "./settings-nav";
import { fetchUsage, usageRows, type Usage, type UsageRow, type UsageTone } from "./usage";

const TONE_DOT: Record<ServiceView["tone"], string> = {
  good: "bg-good",
  caution: "bg-caution",
  danger: "bg-danger",
  muted: "bg-ink-3",
};

const BAR: Record<UsageTone, string> = { accent: "bg-accent", caution: "bg-caution", danger: "bg-danger" };
const LEFT: Record<UsageTone, string> = { accent: "text-ink", caution: "text-caution-ink", danger: "text-danger-ink" };

/** How often an open page reads the usage again, while visible. */
const USAGE_REFRESH_MS = 60_000;

/** The visitor's usage (GET /api/access?usage=1), read on mount and every minute; `undefined` until the first read. */
function useUsage(): { usage: Usage | null | undefined; elapsedS: number } {
  const [read, setRead] = useState<{ usage: Usage | null; at: number } | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const usage = await fetchUsage();
      if (alive) {
        const at = Date.now();
        setRead({ usage, at });
        setNow(at);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, USAGE_REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(tick);
    };
  }, []);
  return { usage: read?.usage, elapsedS: read ? Math.max(0, Math.floor((now - read.at) / 1000)) : 0 };
}

/** One limit: name and reset on the left, "used X of Y" and "Z left" in mono on the right, a thin bar under both. */
function LimitRow({ row }: { row: UsageRow }) {
  return (
    <li className="flex flex-col gap-3 px-5 py-4" data-testid={`usage-${row.key}`}>
      <div className="flex items-end justify-between gap-6 max-sm:flex-col max-sm:items-start max-sm:gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[15px] leading-[22px] font-semibold text-ink">{row.name}</p>
          <p className="text-[13px] leading-5 text-ink-2">{row.resets}</p>
        </div>
        <div className="flex shrink-0 items-baseline gap-5 font-mono tabular-nums">
          <p className="flex items-baseline gap-1.5 text-ink-2">
            <span className="text-[13px] leading-5">used</span>
            <span className="text-[26px] leading-8 font-medium text-ink">{row.used}</span>
            <span className="text-[13px] leading-5">of {row.limit}</span>
          </p>
          <p className="flex items-baseline gap-1.5 text-ink-2">
            <span className={cx("text-[26px] leading-8 font-medium", LEFT[row.tone])}>{row.left}</span>
            <span className="text-[13px] leading-5">left</span>
          </p>
        </div>
      </div>
      <div
        role="progressbar"
        aria-label={row.name}
        aria-valuemin={0}
        aria-valuemax={row.limit}
        aria-valuenow={Math.min(row.used, row.limit)}
        className="h-1 w-full overflow-hidden rounded-full bg-sunken"
      >
        <div className={cx("h-full rounded-full transition-[width] duration-300", BAR[row.tone])} style={{ width: `${row.share * 100}%` }} />
      </div>
    </li>
  );
}

/**
 * Settings > Plan & usage: the plan, and one row per limit this visitor can reach with what is used
 * and left, read live from the server (GET /api/access?usage=1, GET /api/follows). A limit whose use
 * cannot be read is left out, never shown with a guessed figure.
 */
export function PlanUsage() {
  const access = useAccess();
  const follows = useFollows();
  const { usage, elapsedS } = useUsage();
  const review = access?.lane === "judge";
  const service = serviceView(access === null ? undefined : access.mode, access?.message ?? null, access?.until ?? null);
  const followUse = follows.kind === "ready" ? { used: follows.follows.length, max: follows.max } : null;
  const rows = usageRows(usage ?? null, followUse, elapsedS);
  const loading = usage === undefined || follows.kind === "loading";

  return (
    <div className="flex flex-col" data-testid="settings-plan">
      <header className="flex animate-rise flex-col gap-3 pb-10 max-md:pb-8">
        <h1 className="font-display text-[38px] leading-[46px] font-medium tracking-[-0.01em] text-ink max-md:text-[30px] max-md:leading-9">
          Plan &amp; usage
        </h1>
      </header>

      <section aria-labelledby="settings-plan-name" className="flex animate-rise flex-col gap-3 border-t border-line pt-7 pb-10 max-md:pt-6 max-md:pb-8">
        <h2 id="settings-plan-name" className={SETTINGS_LABEL}>
          Plan
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="font-display text-[26px] leading-8 font-medium text-ink">{access ? laneName(access.lane) : " "}</p>
          <p aria-live="polite">
            <span className="inline-flex items-center gap-2 rounded-control border border-line bg-surface px-2.5 py-1.5 font-mono text-[12px] leading-4 text-ink-2">
              <span aria-hidden className={cx("size-1.5 rounded-full", TONE_DOT[service.tone])} />
              <span className="font-medium text-ink">{service.label}</span>
            </span>
          </p>
        </div>
        {service.tone === "caution" || service.tone === "danger" ? <p className="text-[13px] leading-5 text-ink-2">{service.detail}</p> : null}
      </section>

      <section
        aria-labelledby="settings-plan-usage"
        style={{ animationDelay: "50ms" }}
        className="flex animate-rise flex-col gap-4 border-t border-line pt-7 max-md:pt-6"
      >
        <h2 id="settings-plan-usage" className={SETTINGS_LABEL}>
          {review ? "Usage · shared by all review passes" : "Usage"}
        </h2>
        {rows.length > 0 ? (
          <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface" aria-busy={loading}>
            {rows.map((row) => (
              <LimitRow key={row.key} row={row} />
            ))}
          </ul>
        ) : (
          <p className="rounded-card border border-line bg-surface px-5 py-4 text-[13px] leading-5 text-ink-2">
            {loading ? "Reading your usage…" : "Your usage could not be read just now."}
          </p>
        )}
      </section>
    </div>
  );
}
