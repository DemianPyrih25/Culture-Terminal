"use client";

import { useEffect, useState, type ReactNode } from "react";
import { plural } from "../../lib/brief/format";
import { Button } from "../ui/button";
import { copyText } from "../ui/clipboard";
import { cx } from "../ui/cx";
import { DrawerShell } from "../ui/drawer-shell";
import { Icon, type IconName } from "../ui/icons";
import { Segmented, segmentedPanelId, segmentedTabId } from "../ui/segmented";
import { EYEBROW } from "./eyebrow";
import type { ProfileHow, ProfileSource } from "./profile-model";

/**
 * How we know, for a profile (G-R7): what was checked, then every Qloo request behind the page with its
 * endpoint, filter, rows, freshness and request id. Profiles carry no Qloo ids or request parameters, so
 * there is no "Copy as curl".
 */

export type HowTab = "summary" | "sources";

/** What the drawer shows: a tab, and on Sources the request a Source button pointed at. */
export interface HowTarget {
  tab: HowTab;
  receipt: number | null;
}

const ID_PREFIX = "profile-how";

function KeyValue({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[112px] shrink-0 text-ink-3 max-md:w-24">{k}</dt>
      <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function SourceRow({ source, open, onToggle, onCopied }: { source: ProfileSource; open: boolean; onToggle: () => void; onCopied: () => void }) {
  const line = [source.endpoint, source.filter, source.rows === null ? null : plural(source.rows, "row")].filter(Boolean).join(" · ");
  const panel = `profile-source-${source.n}`;
  return (
    <li id={`source-${source.n}`} className="scroll-mt-2" data-source={source.n}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panel}
        className="flex w-full items-start gap-2.5 rounded-sm py-3 text-left hover:bg-canvas"
      >
        <Icon name="chevron-right" size={14} className={cx("mt-[3px] shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="type-label text-ink">{source.title}</span>
          <span className="type-mono text-ink-2 [overflow-wrap:anywhere]">{line}</span>
          <span className="type-caption text-ink-3">{source.fresh}</span>
          {source.error ? <span className="type-caption text-danger-ink">This request failed: {source.error}</span> : null}
        </span>
      </button>
      {open ? (
        <div id={panel} className="flex flex-col gap-3 pb-4 pl-6">
          <dl className="flex flex-col gap-1 rounded-sm border border-line bg-canvas p-3 type-mono">
            <KeyValue k="Endpoint">{source.endpoint}</KeyValue>
            {source.filter ? <KeyValue k="Filter">{source.filter}</KeyValue> : null}
            <KeyValue k="Rows">{source.rows ?? "No data"}</KeyValue>
            {source.live ? <KeyValue k="Time">{source.ms} ms</KeyValue> : null}
            <KeyValue k="Request id">{source.requestId ?? "None"}</KeyValue>
          </dl>
          {source.requestId ? (
            <div>
              <Button
                variant="secondary"
                size="sm"
                icon="copy"
                onClick={() => {
                  void copyText(source.requestId ?? "").then((ok) => {
                    if (ok) onCopied();
                  });
                }}
              >
                Copy id
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** One Summary group: a small-caps label over its line, hairline rules between groups. */
function Group({ label, icon, iconClassName, children }: { label: string; icon?: IconName; iconClassName?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-line py-4 first:pt-0 last:border-b-0">
      <h3 className={EYEBROW}>{label}</h3>
      <div className="flex items-start gap-2 type-body text-ink">
        {icon ? <Icon name={icon} size={16} className={cx("mt-1 shrink-0", iconClassName ?? "text-ink-3")} /> : null}
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

// The view's cost (how.cost) is a usage line: it lives on Settings > Plan & usage, not in this drawer.
function Summary({ how }: { how: ProfileHow }) {
  const all = how.total > 0 && how.traced === how.total;
  return (
    <div className="flex flex-col">
      <Group label="Trace" icon={all ? "badge-check" : "triangle-alert"} iconClassName={all ? "text-good" : "text-caution"}>
        {all ? `All ${how.total} numbers traced to a Qloo request.` : `${how.traced} of ${how.total} numbers traced to a Qloo request.`}
      </Group>
      <Group label="Requests" icon="list-checks">
        {plural(how.requests, "Qloo request")} · {how.saved} saved {how.saved === 1 ? "copy" : "copies"}, {how.live} fetched live
      </Group>
      <Group label="Name" icon="circle-check">
        {how.matched}
      </Group>
      <Group label="Written by" icon="file-text">
        Code only. No AI model writes or reads any of this page.
      </Group>
      {how.notes.length > 0 ? (
        <section className="flex flex-col gap-2 py-4">
          <h3 className={EYEBROW}>Good to know</h3>
          <ul className="flex flex-col gap-2">
            {how.notes.map((note) => (
              <li key={note} className="flex gap-3 type-body text-ink-2">
                <span aria-hidden="true" className="mt-[10px] size-1 shrink-0 rounded-full bg-ink-3" />
                {note}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export interface ProfileDrawerProps {
  how: ProfileHow;
  /** Null: closed. */
  target: HowTarget | null;
  onTarget: (target: HowTarget) => void;
  onClose: () => void;
  /** Shows the "Copied" toast. */
  onCopied: () => void;
}

export function ProfileDrawer({ how, target, onTarget, onClose, onCopied }: ProfileDrawerProps) {
  // The rows the reader opened; the request a Source button pointed at opens with it.
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const focus = target?.tab === "sources" ? target.receipt : null;
  const isOpen = (n: number) => opened.has(n) !== (n === focus);

  useEffect(() => {
    if (focus === null) return;
    document.getElementById(`source-${focus}`)?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  const tab = target?.tab ?? "summary";
  return (
    <DrawerShell
      open={target !== null}
      onClose={() => {
        setOpened(new Set());
        onClose();
      }}
      title="How we know"
      subtitle="The data and checks behind this profile."
      toolbar={
        <Segmented
          kind="tablist"
          idPrefix={ID_PREFIX}
          width="full"
          label="How we know"
          value={tab}
          onChange={(next) => onTarget({ tab: next, receipt: null })}
          options={[
            { value: "summary", label: "Summary" },
            { value: "sources", label: `Sources (${how.sources.length})` },
          ]}
        />
      }
    >
      <div id={segmentedPanelId(ID_PREFIX, tab)} role="tabpanel" aria-labelledby={segmentedTabId(ID_PREFIX, tab)}>
        {tab === "summary" ? (
          <Summary how={how} />
        ) : how.sources.length === 0 ? (
          <p className="type-body text-ink-2">No Qloo request was made for this page.</p>
        ) : (
          <ol className="flex flex-col divide-y divide-line">
            {how.sources.map((source) => (
              <SourceRow
                key={source.n}
                source={source}
                open={isOpen(source.n)}
                onCopied={onCopied}
                onToggle={() =>
                  setOpened((prev) => {
                    const next = new Set(prev);
                    if (next.has(source.n)) next.delete(source.n);
                    else next.add(source.n);
                    return next;
                  })
                }
              />
            ))}
          </ol>
        )}
      </div>
    </DrawerShell>
  );
}
