// /dev/ui: every component of the Concept A kit in every state, laid out like the A·C Components sheet
// (design/exports/concept-a, mqrM0) for side-by-side checks. Development only. Entities, findings,
// values, counts, dates and request ids are invented and match nothing in the design exports (D29).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ConvictionMark, RunningHead } from "../../../components/chrome/running-head";
import { StatusLine } from "../../../components/chrome/status-line";
import { TopBar } from "../../../components/chrome/top-bar";
import { BriefGrid } from "../../../components/layout/brief-grid";
import { BriefRow } from "../../../components/layout/brief-row";
import { SCROLL_ANCHOR_CLASS } from "../../../components/layout/grid";
import { Outline, type OutlineItem } from "../../../components/layout/outline";
import { Button, ButtonLink, IconButton } from "../../../components/ui/button";
import { Delta } from "../../../components/ui/delta";
import { Checkbox, Input, Search, Select } from "../../../components/ui/fields";
import { DownloadIcon, ICON_NAMES, Icon, LinkIcon } from "../../../components/ui/icons";
import { Keycap } from "../../../components/ui/keycap";
import { MetaLine } from "../../../components/ui/meta-line";
import { MiniMeter } from "../../../components/ui/mini-meter";
import { NoSignal } from "../../../components/ui/no-signal";
import { SectionHead } from "../../../components/ui/section-head";
import {
  CommandFieldDemo,
  CommandFieldFocusDemo,
  PopoverDemo,
  PopoverTopDemo,
  SortToggleDemo,
} from "./demos";

export const metadata: Metadata = {
  title: "UI kit · Culture Terminal",
  robots: { index: false, follow: false },
};

const BRIEF_OUTLINE: OutlineItem[] = [
  { id: "answer", label: "Answer" },
  { id: "conviction", label: "Conviction" },
  { id: "evidence", label: "Evidence" },
  { id: "risks", label: "Risks" },
  { id: "method", label: "Method" },
  { id: "sources", label: "Sources" },
];

const LIVE_OUTLINE: OutlineItem[] = BRIEF_OUTLINE.map((item, i) => (i < 3 ? item : { ...item, pending: true }));

const LIBRARY_OUTLINE: OutlineItem[] = [
  { id: "desk-investment", label: "Investment", count: 9 },
  { id: "desk-location", label: "Location", count: 7 },
  { id: "desk-marketing", label: "Marketing", count: 6 },
  { id: "desk-audience", label: "Audience", count: 5 },
];

const GRID_OUTLINE: OutlineItem[] = [
  { id: "demo-answer", label: "Answer" },
  { id: "demo-conviction", label: "Conviction" },
  { id: "demo-evidence", label: "Evidence" },
  { id: "demo-sources", label: "Sources" },
];

// A00 · 01 Palette: the tokens of globals.css, in the design's order and groups.
const PALETTE: ReadonlyArray<ReadonlyArray<{ name: string; swatch: string; hex: string; role: string }>> = [
  [
    { name: "paper", swatch: "bg-paper", hex: "#FFFFFF", role: "Reading surface" },
    { name: "canvas", swatch: "bg-canvas", hex: "#F7F7F5", role: "Chrome, plot ground" },
  ],
  [
    { name: "ink", swatch: "bg-ink", hex: "#121416", role: "Text, primary button" },
    { name: "text-2", swatch: "bg-text-2", hex: "#3D4248", role: "Body copy" },
    { name: "dim", swatch: "bg-dim", hex: "#6B7178", role: "Captions, labels" },
    { name: "faint", swatch: "bg-faint", hex: "#A3A8AE", role: "Ids, placeholders" },
  ],
  [
    { name: "line", swatch: "bg-line", hex: "#E6E7E9", role: "Hairlines" },
    { name: "line-strong", swatch: "bg-line-strong", hex: "#C9CCD0", role: "Rules, field borders" },
  ],
  [
    { name: "accent", swatch: "bg-accent", hex: "#1C3D6E", role: "Links, active, marker" },
    { name: "accent-soft", swatch: "bg-accent-soft", hex: "#E8EDF4", role: "Selected option" },
  ],
  [
    { name: "negative", swatch: "bg-negative", hex: "#8E2F2F", role: "Refuted, under-index" },
    { name: "negative-soft", swatch: "bg-negative-soft", hex: "#F5EAEA", role: "Under-index ground" },
  ],
  [
    { name: "data", swatch: "bg-data", hex: "#1C3D6E", role: "Subject series" },
    { name: "data-2", swatch: "bg-data-2", hex: "#A9B0B8", role: "Comparison series" },
    { name: "on-ink", swatch: "bg-on-ink", hex: "#FFFFFF", role: "Text on ink" },
  ],
];

// A00 · 04 Type: one specimen per type utility.
const TYPE_RAMP: ReadonlyArray<{ name: string; spec: string; className: string; sample: string }> = [
  { name: "Question", spec: "Serif 40/48 · 500", className: "type-question text-ink", sample: "Where does each brand lead?" },
  { name: "Answer", spec: "Serif 20/30", className: "type-answer text-ink", sample: "A crowded shelf, two clear lanes." },
  { name: "Key figure", spec: "Serif 32/37 · 500", className: "type-key-figure text-ink", sample: "0.64   3 of 5   +0.27" },
  { name: "Figure title", spec: "Serif 18/24 · 600", className: "type-figure-title text-ink", sample: "Brand Beta leads the river towns" },
  { name: "Body", spec: "Inter 15/22", className: "type-body text-ink", sample: "We expected: Brand Gamma as the nearest rival." },
  { name: "Interface", spec: "Inter 13/20 · 500", className: "type-ui text-ink", sample: "Briefs   Following   Method" },
  { name: "Label", spec: "Inter 11 · 600", className: "type-label text-dim", sample: "Conviction · Figure 1" },
  { name: "Sidenote", spec: "Inter 12/17", className: "type-sidenote text-dim", sample: "Qloo /v2/insights · tags ← R3 · 12 rows" },
  { name: "Trace", spec: "Plex Mono 10.5/15", className: "type-trace text-faint", sample: "req 3e7a…b9f0 · cached 5h" },
];

/** A section rule of the sheet: 01 CHROME · aside. */
function SheetSection({ number, title, aside, children }: { number: string; title: string; aside: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`sheet-${number}`} className="flex w-full flex-col gap-3">
      <div className="px-6">
        <div className="flex items-center gap-3 border-t border-line-strong pt-[10px] leading-[14px]">
          <h2 id={`sheet-${number}`} className="flex gap-3 text-[11px] font-semibold tracking-[1.3px] uppercase">
            <span className="text-faint">{number}</span>
            <span className="text-ink">{title}</span>
          </h2>
          <p className="text-[12px] text-dim">{aside}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/** A specimen: the master's name in mono over the component. */
function Slot({ name, children, className }: { name: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col items-start gap-2 ${className ?? ""}`}>
      <p className="font-mono text-[10px] leading-[14px] text-faint">{name}</p>
      {children}
    </div>
  );
}

function Sidenote({ n, text, trace }: { n: number; text: string; trace: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-3 shrink-0 text-[11px] leading-[17px] font-semibold text-accent">{n}</span>
      <div className="flex flex-col gap-[2px]">
        <p className="type-sidenote text-dim">{text}</p>
        <p className="type-trace text-faint">{trace}</p>
      </div>
    </div>
  );
}

export default function UiKitPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="flex w-full flex-col gap-6 bg-paper py-8">
      <header className="flex flex-wrap items-end gap-x-10 gap-y-2 px-6">
        <div className="flex flex-col gap-[6px]">
          <p className="text-[11px] font-semibold tracking-[1.3px] text-accent uppercase">Dev · Concept A kit</p>
          <h1 className="font-serif text-[28px] font-medium tracking-[-0.3px] text-ink">Components</h1>
        </div>
        <p className="flex-1 text-right text-[12px] leading-[18px] text-dim">
          Every kit component in every state. Widths follow the brief grid: 70 · 200 · 60 · 680 · 60 · 300 · 70.
          Press ⌘K to focus the top bar&apos;s field and / to focus Search briefs, as on the briefs library.
        </p>
      </header>

      <SheetSection number="00" title="Foundations" aside="Palette and type ramp of A00, from the tokens in globals.css">
        <div className="flex flex-wrap items-start gap-10 px-6">
          <ul className="flex w-[300px] flex-col gap-[5px]">
            {PALETTE.map((group, g) => (
              <li key={g}>
                <ul className="flex flex-col">
                  {group.map((token) => (
                    <li key={token.name} className="flex h-[18px] items-center gap-[6px]">
                      <span className={`h-3 w-5 shrink-0 border border-line ${token.swatch}`} />
                      <span className="w-24 font-mono text-[10.5px] text-ink">${token.name}</span>
                      <span className="w-[50px] font-mono text-[9.5px] text-faint">{token.hex}</span>
                      <span className="flex-1 text-[11px] text-dim">{token.role}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <dl className="flex w-[460px] max-w-full flex-col">
            {TYPE_RAMP.map((row) => (
              <div key={row.name} className="flex items-center gap-4 border-b border-line py-2">
                <dt className="flex w-24 shrink-0 flex-col gap-px">
                  <span className="text-[11px] text-ink">{row.name}</span>
                  <span className="font-mono text-[9px] text-faint">{row.spec}</span>
                </dt>
                <dd className={`min-w-0 whitespace-pre-wrap ${row.className}`}>{row.sample}</dd>
              </div>
            ))}
          </dl>
        </div>
      </SheetSection>

      <SheetSection number="01" title="Chrome" aside="Top bar 1440 × 56 · Running head 1440 × 44 · Status line 1440 × 32">
        <div className="flex flex-col">
          <TopBar
            sticky={false}
            active="briefs"
            command={<CommandFieldDemo shortcut={["mod-k"]} echo placeholder="Ask a question" />}
          />
          <RunningHead
            sticky={false}
            desk="Investment"
            job="Competitors"
            question="Which brands sit closest to Juniper Cola?"
            finding="A crowded shelf, nearest to cold brew"
            right={
              <>
                <ConvictionMark band="High" score={72} />
                <span className="flex-1" />
                <IconButton label="Export PDF">
                  <DownloadIcon size={16} />
                </IconButton>
                <IconButton label="Copy link">
                  <LinkIcon size={16} />
                </IconButton>
              </>
            }
          />
          <StatusLine sticky={false} snapshot="6 Jul 2026" trendWindow="Jan–Jun 2026" requests={{ total: 12, cached: 5 }} />
        </div>
        <div className="flex flex-col gap-2 px-6 pt-2">
          <Slot name="A/Top bar · method enabled, nothing active">
            <TopBar sticky={false} enabled={{ following: true, method: true }} command={<CommandFieldDemo />} />
          </Slot>
          <Slot name="Running head · pending conviction, no finding yet">
            <RunningHead
              sticky={false}
              desk="Audience"
              job="Who they are"
              question="Which tastes travel with Brand Beta fans?"
              right={<ConvictionMark band={null} score={null} />}
            />
          </Slot>
          <Slot name="A/Status line · custom right text">
            <StatusLine sticky={false} snapshot="6 Jul 2026" trendWindow="Jan–Jun 2026" requests="Qloo 87 / 1,900 req today" />
          </Slot>
        </div>
        <div className="flex flex-wrap items-start gap-8 px-6 pt-3">
          <Slot name="A/Keycap">
            <div className="flex gap-2">
              <Keycap>⌘K</Keycap>
              <Keycap>/</Keycap>
              <Keycap>↵</Keycap>
              <Keycap>Esc</Keycap>
            </div>
          </Slot>
          <Slot name="A/Command field" className="w-[520px] max-w-full">
            <CommandFieldDemo />
          </Slot>
          <Slot name="Command field · focus (instance)" className="w-[520px] max-w-full">
            <CommandFieldDemo initial="Brand Alpha vs Brand Beta" showFocus />
          </Slot>
          <Slot name="Command field · disabled · imperative focus, no key bound" className="w-[520px] max-w-full">
            <div className="flex w-full flex-col gap-3">
              <CommandFieldDemo disabled placeholder="Ask a follow-up on this brief" />
              <CommandFieldFocusDemo />
            </div>
          </Slot>
        </div>
      </SheetSection>

      <SheetSection number="02" title="Brief, margin and controls" aside="Reading-column blocks are 680 wide, sidenotes 300, outline 200">
        <div className="flex flex-wrap items-start gap-8 px-6">
          <div className="flex w-[680px] max-w-full flex-col gap-[18px]">
            <Slot name="A/Meta line · A/Section head">
              <div className="flex w-full flex-col gap-[10px]">
                <MetaLine desk="Investment" job="Compare two brands" briefId="Brief 0001" date="6 Jul 2026" />
                <MetaLine desk="Library" job="27 briefs" extra={["Invented Capital"]} />
                <SectionHead number={2} title="Conviction" aside="Computed, not chosen" />
                <SectionHead number="03" title="Evidence" />
              </div>
            </Slot>
            <Slot name="A/Delta · over / under / flat / unavailable">
              <Delta value={0.27} comparator="vs category median" />
              <Delta value={-0.12} comparator="vs city" />
              <Delta value={0} comparator="vs last window" />
              <Delta value={null} comparator="vs peers" />
              <Delta value={2} display="+2 places" comparator="vs Brand Alpha" />
            </Slot>
            <Slot name="Mini meter · 72 / 35 / pending · compact 56 / row 36">
              <div className="flex flex-wrap items-center gap-6">
                <MiniMeter value={72} label="Conviction" />
                <MiniMeter value={35} label="Conviction" />
                <MiniMeter value={null} label="Conviction" />
                <MiniMeter value={72} label="Conviction" width={56} markerHeight={9} />
                <MiniMeter value={72} label="Conviction" width={36} markerHeight={0} />
              </div>
            </Slot>
            <Slot name="Popover · request inspector (click the number) · placement top-end">
              <PopoverDemo />
              <PopoverTopDemo />
            </Slot>
            <Slot name="Icons · 14 px, currentColor">
              <ul className="flex flex-wrap gap-5 text-text-2">
                {ICON_NAMES.map((name) => (
                  <li key={name} className="flex flex-col items-center gap-2">
                    <Icon name={name} />
                    <span className="font-mono text-[10px] text-faint">{name}</span>
                  </li>
                ))}
              </ul>
            </Slot>

            <div className="flex flex-wrap items-start gap-[30px]">
              <div className="flex w-[200px] flex-col gap-[18px]">
                <Slot name="A/Outline" className="w-full">
                  <Outline
                    items={BRIEF_OUTLINE}
                    activeId="answer"
                    meta={{ trace: "Brief 0001", text: "3 min read · 1 figure · 12 sources" }}
                  />
                </Slot>
                <Slot name="A/No signal">
                  <NoSignal after="Jun 2026" />
                  <NoSignal />
                </Slot>
              </div>

              <div className="flex w-[200px] flex-col gap-[18px]">
                <Slot name="A/Button · primary">
                  <Button variant="primary">Ask</Button>
                </Slot>
                <Slot name="A/Button · secondary">
                  <Button icon={<DownloadIcon />}>Export PDF</Button>
                  <Button icon={<LinkIcon />} size="sm">
                    Share
                  </Button>
                </Slot>
                <Slot name="A/Button · quiet">
                  <ButtonLink href="/dev/ui">Follow this subject</ButtonLink>
                </Slot>
                <Slot name="Buttons · disabled">
                  <Button variant="primary" disabled>
                    Ask
                  </Button>
                  <Button icon={<DownloadIcon />} disabled>
                    Export PDF
                  </Button>
                  <Button variant="quiet" disabled>
                    Follow this subject
                  </Button>
                </Slot>
              </div>

              <div className="flex w-[220px] flex-col gap-[18px]">
                <Slot name="Icon buttons · 28 px">
                  <div className="flex gap-[2px]">
                    <IconButton label="Export PDF">
                      <DownloadIcon size={16} />
                    </IconButton>
                    <IconButton label="Copy link">
                      <LinkIcon size={16} />
                    </IconButton>
                    <IconButton label="Copy link" disabled>
                      <LinkIcon size={16} />
                    </IconButton>
                  </div>
                </Slot>
                <Slot name="A/Sort toggle">
                  <SortToggleDemo />
                </Slot>
              </div>
            </div>
          </div>

          <div className="flex w-[680px] max-w-full flex-wrap items-start justify-between gap-y-[18px]">
            <div className="flex w-[300px] flex-col gap-[18px]">
              <Slot name="Outline · being written" className="w-[200px]">
                <Outline
                  items={LIVE_OUTLINE}
                  activeId="conviction"
                  meta={{ trace: "Brief 0002", text: "Being written · since 10:41:27" }}
                />
              </Slot>
              <Slot name="Outline · on this page, counts" className="w-[200px]">
                <Outline
                  items={LIBRARY_OUTLINE}
                  heading="On this page"
                  activeId="desk-investment"
                  meta={{ text: "Latest 2 per desk. Open a desk for the full list." }}
                />
              </Slot>
            </div>

            <div className="flex w-[300px] flex-col gap-[18px]">
              <Slot name="A/Input" className="w-full">
                <Input label="Default metros" defaultValue="Denver, Atlanta, Seattle" help="Used when a question names no place." />
              </Slot>
              <Slot name="Input · error · disabled" className="w-full">
                <Input label="Daily request cap" defaultValue="0" error="Use a whole number of 1 or more." />
                <Input label="Workspace" defaultValue="Invented Capital" disabled />
              </Slot>
              <Slot name="A/Select" className="w-full">
                <Select label="Units" defaultValue="index">
                  <option value="index">Index vs US baseline = 1.00</option>
                  <option value="share">Share of taste, 0–1</option>
                </Select>
              </Slot>
              <Slot name="A/Search · bound to /" className="w-full">
                <Search placeholder="Search briefs" shortcut />
              </Slot>
              <Slot name="Search · no key bound, no hint" className="w-full">
                <Search placeholder="Filter sources" />
              </Slot>
              <Slot name="A/Checkbox">
                <Checkbox defaultChecked>Add the method appendix to PDFs</Checkbox>
                <Checkbox>Show sidenotes inline on narrow windows</Checkbox>
                <Checkbox disabled>Email a digest (not available)</Checkbox>
              </Slot>
            </div>
          </div>
        </div>
      </SheetSection>

      <SheetSection number="03" title="Brief grid" aside="Outline sticky · sidenotes level with their row · fold under 1280 · Report | Sources under 768">
        <BriefGrid
          stickyTop={24}
          outline={<Outline items={GRID_OUTLINE} meta={{ trace: "Brief 0003 · 6 Jul 2026", text: "Scroll: the marker follows" }} />}
        >
          <BriefRow
            id="demo-answer"
            className={`pt-[30px] pb-10 ${SCROLL_ANCHOR_CLASS}`}
            notes={
              <Sidenote
                n={1}
                text="Qloo /v2/insights · tags ← R3 · 12 rows. Affinity by region for both brands, from one request."
                trace="req 3e7a…b9f0 · cached 5h"
              />
            }
          >
            <MetaLine desk="Investment" job="Compare two brands" briefId="Brief 0003" date="6 Jul 2026" />
            <h3 className="type-question mt-4 text-ink">Brand Alpha or Brand Beta: where does each lead?</h3>
            <p className="type-answer mt-6 text-ink">
              A crowded shelf, two clear lanes.<sup className="text-[11px] font-semibold text-accent">1</sup> Brand Beta
              leads the river towns; Brand Alpha holds the hill cities.
            </p>
          </BriefRow>
          <BriefRow
            id="demo-conviction"
            className={`pb-[320px] ${SCROLL_ANCHOR_CLASS}`}
            notes={
              <Sidenote n={2} text="Region index against the national median, from five regions." trace="computed in code · QUANT" />
            }
          >
            <SectionHead number={2} title="Conviction" aside="Computed, not chosen" />
            <p className="type-body mt-4 text-text-2">
              Conviction is computed from fixed rules, never picked by the model. This band stands in for the priors and
              the strip.
            </p>
          </BriefRow>
          <BriefRow id="demo-evidence" className={`pb-[400px] ${SCROLL_ANCHOR_CLASS}`}>
            <SectionHead number={3} title="Evidence" aside="1 figure · 6 requests" />
            <p className="type-body mt-4 text-text-2">
              A row without sidenotes: on a phone it disappears from the Sources tab.
            </p>
          </BriefRow>
          <BriefRow
            id="demo-sources"
            className={`pb-[240px] ${SCROLL_ANCHOR_CLASS}`}
            notes={<Sidenote n={3} text="Qloo /v2/insights · tags ← R4 · 9 rows." trace="req 5c0d…e21a · live 6 Jul, 10:42" />}
          >
            <SectionHead number={6} title="Sources" aside="Every Qloo request" />
            <p className="type-body mt-4 text-text-2">The last section lights up at the bottom of the page.</p>
          </BriefRow>
        </BriefGrid>
      </SheetSection>
    </main>
  );
}
