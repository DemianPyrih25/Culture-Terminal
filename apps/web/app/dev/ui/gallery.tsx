"use client";

// The interactive parts of /dev/ui: segmented controls, a chart card with its table view, the confidence
// chip and its popover, the toast and the drawer shell. Invented data only (D29).
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { ChartCard, ChartTable } from "../../../components/ui/chart-card";
import { ConfidenceChip, ConfidencePopoverBody } from "../../../components/ui/confidence";
import { DrawerShell } from "../../../components/ui/drawer-shell";
import { KeyNumber, type KeyNumberProps } from "../../../components/ui/key-number";
import { Segmented, segmentedPanelId, segmentedTabId } from "../../../components/ui/segmented";
import { Tag } from "../../../components/ui/tag";
import { useToast } from "../../../components/ui/toast";

type View = "chart" | "table";
type Speed = "1" | "4";
type Tab = "summary" | "numbers" | "sources" | "method";

const TABS = [
  { value: "summary", label: "Summary" },
  { value: "numbers", label: "Numbers (12)" },
  { value: "sources", label: "Sources (6)" },
  { value: "method", label: "Method" },
] as const;

/** The panel a tablist demo controls, so each tab's aria-controls points at a real element. */
function DemoPanel({ idPrefix, tab }: { idPrefix: string; tab: Tab }) {
  return (
    <div id={segmentedPanelId(idPrefix, tab)} role="tabpanel" aria-labelledby={segmentedTabId(idPrefix, tab)} className="type-caption text-ink-2">
      The {tab} tab.
    </div>
  );
}

export function SegmentedDemo() {
  const [view, setView] = useState<View>("chart");
  const [view2, setView2] = useState<View>("table");
  const [speed, setSpeed] = useState<Speed>("1");
  const [tab, setTab] = useState<Tab>("summary");
  const [tab2, setTab2] = useState<Tab>("numbers");
  const views = [
    { value: "chart", label: "Chart" },
    { value: "table", label: "Table" },
  ] as const;
  return (
    <div className="flex w-[470px] max-w-full flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <Segmented label="View" options={views} value={view} onChange={setView} />
        <Segmented label="View" options={views} value={view2} onChange={setView2} />
        <Segmented
          label="Speed"
          options={[
            { value: "1", label: "1×" },
            { value: "4", label: "4×" },
          ]}
          value={speed}
          onChange={setSpeed}
        />
      </div>
      <Segmented label="How we know" kind="tablist" idPrefix="demo-a" width="full" options={TABS} value={tab} onChange={setTab} />
      <DemoPanel idPrefix="demo-a" tab={tab} />
      <Segmented label="How we know" kind="tablist" idPrefix="demo-b" width="full" options={TABS} value={tab2} onChange={setTab2} />
      <DemoPanel idPrefix="demo-b" tab={tab2} />
    </div>
  );
}

const ROWS = [
  { name: "Pinecone Soap Co.", category: "personal care", value: 0.84, outside: true },
  { name: "Hollowpeak Water", category: "bottled water", value: 0.79, outside: false },
  { name: "Bramble Tea", category: "iced tea", value: 0.76, outside: true },
  { name: "Northspring Water", category: "bottled water", value: 0.74, outside: false },
  { name: "Kelpwise Water", category: "bottled water", value: 0.71, outside: false },
];

/** A stand-in plot (the real bar rows are stream F's): enough to show the card shell. */
function DemoBars() {
  return (
    <div role="img" aria-label="Closest audiences" className="flex flex-col gap-2">
      {ROWS.map((row) => (
        <div key={row.name} className="flex items-center gap-4">
          <div className="w-[200px] shrink-0">
            <p className="type-body text-ink">{row.name}</p>
            <p className="type-caption text-ink-2">{row.category}</p>
          </div>
          <div className="relative h-3 flex-1 rounded-r-xs bg-sunken">
            <div
              className={row.outside ? "h-3 rounded-r-xs bg-accent" : "h-3 rounded-r-xs bg-chart-muted"}
              style={{ width: `${row.value * 70}%` }}
            />
          </div>
          <span className="w-10 type-label text-ink-2 tabular-nums">{row.value.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

export function ChartCardDemo({ draft = false }: { draft?: boolean }) {
  return (
    <ChartCard
      kind="Closest audiences"
      title={draft ? "Its closest audience is a soap brand (draft)." : "Its closest audience is a soap brand, not another water brand."}
      draft={draft}
      legend={[
        { label: "Outside its category", tone: "accent" },
        { label: "Bottled water", tone: "muted" },
      ]}
      onSource={draft ? undefined : () => undefined}
      caption="1.00 = identical tastes. Shared taste, not shared customers."
      table={
        <ChartTable
          label="Closest audiences"
          columns={[{ label: "Brand" }, { label: "Category" }, { label: "Match", numeric: true }]}
          rows={ROWS.map((r) => [r.name, r.category, r.value.toFixed(2)])}
        />
      }
    >
      <DemoBars />
    </ChartCard>
  );
}

export function ConfidenceDemo() {
  return (
    <div className="flex flex-col items-start gap-2">
      <ConfidenceChip level="HIGH" lowered={["trend data from an older window (Apr–Sep 2025)"]} onFullBreakdown={() => undefined} />
      <ConfidenceChip level="MED" lowered={["only four of six peers resolved"]} />
      <ConfidenceChip level="LOW" />
      <ConfidenceChip level="insufficient_evidence" />
    </div>
  );
}

/** The popover's panel, drawn open. */
export function ConfidencePopoverStatic() {
  return (
    <div className="w-[320px] max-w-full rounded-control border border-line bg-surface p-4 shadow-lg">
      <ConfidencePopoverBody level="HIGH" lowered={["trend data from an older window (Apr–Sep 2025)"]} onFullBreakdown={() => undefined} />
    </div>
  );
}

export function ToastDemo() {
  const { show, toast } = useToast();
  return (
    <>
      <Button size="sm" icon="copy" onClick={() => show("Link copied")}>
        Show toast
      </Button>
      {toast}
    </>
  );
}

export function DrawerDemo() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("numbers");
  return (
    <>
      <Button icon="shield-check" onClick={() => setOpen(true)}>
        How we know
      </Button>
      <DrawerShell
        open={open}
        onClose={() => setOpen(false)}
        title="How we know"
        subtitle="The data and checks behind this answer."
        toolbar={<Segmented label="How we know" kind="tablist" idPrefix="drawer-demo" width="full" options={TABS} value={tab} onChange={setTab} />}
      >
        <div id={`drawer-demo-panel-${tab}`} role="tabpanel" aria-labelledby={`drawer-demo-tab-${tab}`} className="type-body text-ink-2">
          The {tab} tab goes here (stream C fills the drawer).
        </div>
      </DrawerShell>
    </>
  );
}

const KEY_NUMBERS: KeyNumberProps[] = [
  { variant: "number", value: "0.84 match", label: "Closest audience", context: "Pinecone Soap Co. · 1.00 = identical" },
  { variant: "word", value: "Leans older", label: "Age lean", context: "−0.12 vs the average audience" },
  { variant: "name", value: "Ridgeline Lager", label: "Best fit · beer", context: "#1 of 12 beers" },
  {
    variant: "split",
    label: "Cities where it ranks first",
    sides: [
      { name: "Lumen", value: "4", tone: "subject" },
      { name: "Polar", value: "0", tone: "second" },
    ],
  },
];

/** The four key-number variants in one state. */
export function KeyNumberRow({ state }: { state: "default" | "draft" | "selected" }) {
  return (
    <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
      {KEY_NUMBERS.map((k, i) => (
        <KeyNumber
          key={i}
          {...k}
          draft={state === "draft"}
          selected={state === "selected"}
          onSource={() => undefined}
          tag={i === 2 && state === "default" ? <Tag preset="hidden-gem" /> : undefined}
        />
      ))}
    </div>
  );
}
