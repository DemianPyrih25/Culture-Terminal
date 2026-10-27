// /dev/ui: the design system on one page, laid out like N00 Foundations (U8TSD) and N·C Components (bk4cs)
// in design/redesign.pen, for side-by-side checks. Development only. Every name, value and date is
// invented and matches nothing real (D29).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Footer } from "../../../components/chrome/footer";
import { Header } from "../../../components/chrome/header";
import { LogoMark } from "../../../components/chrome/logo-mark";
import { PageHead } from "../../../components/chrome/page-head";
import { Button, ButtonLink, IconButton } from "../../../components/ui/button";
import { Card, CardTitle } from "../../../components/ui/card";
import { Chip } from "../../../components/ui/chip";
import { cx } from "../../../components/ui/cx";
import { Checkbox, Input, Select } from "../../../components/ui/fields";
import { ICON_NAMES, Icon } from "../../../components/ui/icons";
import { InlineState } from "../../../components/ui/inline-state";
import { Monogram, type MonogramPalette, type MonogramSize } from "../../../components/ui/monogram";
import { Hatch, Skeleton } from "../../../components/ui/skeleton";
import { Tag, type TagPreset } from "../../../components/ui/tag";
import { Toast } from "../../../components/ui/toast";
import { TOPIC_KEYS, TopicTag, TopicTile } from "../../../components/ui/topic";
import { ChartCardDemo, ConfidenceDemo, ConfidencePopoverStatic, DrawerDemo, KeyNumberRow, SegmentedDemo, ToastDemo } from "./gallery";

export const metadata: Metadata = {
  title: "UI kit · Culture Terminal",
  robots: { index: false, follow: false },
};

const SWATCHES: { group: string; tokens: [string, string][] }[] = [
  {
    group: "Surfaces and ink",
    tokens: [
      ["canvas", "#F5F6F8"],
      ["surface", "#FFFFFF"],
      ["sunken", "#EFF1F4"],
      ["line", "#E6E8EC"],
      ["line-strong", "#CDD2DA"],
      ["ink", "#0E1116"],
      ["ink-2", "#4A5261"],
      ["ink-3", "#8A93A3"],
      ["scrim", "#0E1116 · 20 %"],
    ],
  },
  {
    group: "Accent and second",
    tokens: [
      ["accent", "#5B3DF5"],
      ["accent-hover", "#4A2EE0"],
      ["accent-soft", "#EEEBFE"],
      ["accent-ink", "#3A22B8"],
      ["second", "#F2760B"],
      ["second-soft", "#FEF0E3"],
      ["second-ink", "#A4510A"],
    ],
  },
  {
    group: "Status",
    tokens: [
      ["good", "#12A150"],
      ["good-soft", "#E7F6EE"],
      ["good-ink", "#0B7A3B"],
      ["caution", "#E0A100"],
      ["caution-soft", "#FFF6DB"],
      ["caution-ink", "#8A5A00"],
      ["danger", "#D92D20"],
      ["danger-soft", "#FEECEB"],
      ["danger-ink", "#A11F16"],
    ],
  },
  {
    group: "Charts and map ramp",
    tokens: [
      ["chart-muted", "#C9CED6"],
      ["chart-grid", "#EEF0F3"],
      ["map-1", "#F1EEFE"],
      ["map-2", "#D5CCFC"],
      ["map-3", "#A897F9"],
      ["map-4", "#7C63F7"],
      ["map-5", "#5B3DF5"],
    ],
  },
  {
    group: "Monogram neutrals",
    tokens: [
      ["mono-1", "#E0F5F3"],
      ["mono-1-ink", "#0B6B63"],
      ["mono-2", "#E6F1FD"],
      ["mono-2-ink", "#1D5FA8"],
      ["mono-3", "#F6F0E6"],
      ["mono-3-ink", "#7A5A2B"],
      ["mono-4", "#EDEFF3"],
      ["mono-4-ink", "#3D4655"],
    ],
  },
];

const TOPIC_SWATCHES = [
  ["topic-brands", "#FF7A45 · #FFE8DC · #B43C0A"],
  ["topic-places", "#1FB57A · #DDF5EA · #08714A"],
  ["topic-tours", "#F2559B · #FDE3EF · #A8195C"],
  ["topic-audiences", "#F5C02E · #FFF3C9 · #7A5C00"],
] as const;

const TYPE: [string, string][] = [
  ["display-xl", "type-display-xl"],
  ["display-l", "type-display-l"],
  ["display-m", "type-display-m"],
  ["display-s", "type-display-s"],
  ["score", "type-score"],
  ["number-l", "type-number-l"],
  ["name-value", "type-name-value"],
  ["title-l", "type-title-l"],
  ["title", "type-title"],
  ["lead", "type-lead"],
  ["body", "type-body"],
  ["body-strong", "type-body-strong"],
  ["button", "type-button"],
  ["label", "type-label"],
  ["caption", "type-caption"],
  ["mono", "type-mono"],
];

const SPACING = [4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 64, 96];

const TAGS: TagPreset[] = ["ready", "draft", "hidden-gem", "outside-category", "few-rivals", "new-here", "instant", "recording"];

const MONO_ROWS: { palette: MonogramPalette; name: string }[] = [
  { palette: "subject", name: "Lumen Drinks" },
  { palette: "second", name: "Polar Orchard" },
  { palette: "mono-1", name: "Cove Kitchen" },
  { palette: "mono-2", name: "Harbor Supply" },
  { palette: "mono-3", name: "Bramble Roasters" },
  { palette: "mono-4", name: "Maple Arcade" },
];
const MONO_SIZES: MonogramSize[] = [20, 24, 32, 48, 56];

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cx("flex flex-col gap-4", className)}>
      <h2 className="text-[13px] leading-[18px] font-semibold text-ink-2">{title}</h2>
      {children}
    </section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className="type-caption text-ink-2">{children}</p>;
}

function Swatch({ name, hex }: { name: string; hex: string }) {
  return (
    <div className="overflow-hidden rounded-control border border-line bg-surface">
      <div className="h-10 border-b border-line" style={{ background: `var(--color-${name})` }} />
      <div className="px-2 py-1.5">
        <p className="text-[12px] leading-4 font-medium text-ink">{name}</p>
        <p className="font-mono text-[11px] leading-4 text-ink-2">{hex}</p>
      </div>
    </div>
  );
}

export default function UiKitPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="flex flex-col gap-16 px-6 py-12 max-md:px-4 md:px-14">
      <h1 className="type-display-m text-ink">Foundations</h1>

      <Section title="Colours">
        {SWATCHES.map((g) => (
          <div key={g.group} className="flex flex-col gap-2">
            <Label>{g.group}</Label>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] gap-3">
              {g.tokens.map(([name, hex]) => (
                <Swatch key={name} name={name} hex={hex} />
              ))}
              {g.group === "Charts and map ramp" ? (
                <div className="overflow-hidden rounded-control border border-line bg-surface">
                  <div className="h-10 border-b border-line bg-hatch" />
                  <div className="px-2 py-1.5">
                    <p className="text-[12px] leading-4 font-medium text-ink">hatch</p>
                    <p className="font-mono text-[11px] leading-4 text-ink-2">ink-3 on sunken</p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ))}
        <div className="flex flex-col gap-2">
          <Label>Topics</Label>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
            {TOPIC_SWATCHES.map(([name, hex]) => (
              <div key={name} className="overflow-hidden rounded-control border border-line bg-surface">
                <div className="grid h-10 grid-cols-3 border-b border-line">
                  <span style={{ background: `var(--color-${name})` }} />
                  <span style={{ background: `var(--color-${name}-soft)` }} />
                  <span style={{ background: `var(--color-${name}-ink)` }} />
                </div>
                <div className="px-2 py-1.5">
                  <p className="text-[12px] leading-4 font-medium text-ink">{name} · base, soft, ink</p>
                  <p className="font-mono text-[11px] leading-4 text-ink-2">{hex}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section title="Type">
        <div className="flex flex-col gap-3 overflow-hidden">
          {TYPE.map(([name, cls]) => (
            <div key={name} className="grid grid-cols-[120px_minmax(0,1fr)] items-baseline gap-6 max-md:grid-cols-1 max-md:gap-1">
              <Label>{name}</Label>
              <p className={cx(cls, "truncate text-ink")}>
                {name.startsWith("display") || name === "score" ? "A loyal niche, not a moat." : "Fans lean female and 35–44."}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <div className="grid gap-10 lg:grid-cols-2">
        <Section title="Spacing">
          <Card padding="default" className="flex flex-wrap items-end gap-4">
            {SPACING.map((n) => (
              <div key={n} className="flex flex-col items-start gap-1">
                <span className="block h-3 rounded-[2px] bg-accent-soft outline outline-1 outline-map-2" style={{ width: n }} />
                <span className="type-caption text-ink-2">{n}</span>
              </div>
            ))}
          </Card>
        </Section>
        <Section title="Shadows">
          <div className="grid grid-cols-3 gap-6">
            {(["shadow-xs", "shadow-md", "shadow-lg"] as const).map((s) => (
              <div key={s} className={cx("flex h-24 items-center justify-center rounded-card bg-surface type-label text-ink-2", s)}>
                {s}
              </div>
            ))}
          </div>
        </Section>
      </div>

      <Section title="Radii and borders">
        <div className="flex flex-wrap gap-4">
          {[
            ["16", "Card", "rounded-card"],
            ["20", "Question box", "rounded-box"],
            ["12", "Buttons and inputs", "rounded-control"],
            ["12", "Tiles and wells", "rounded-tile"],
            ["999", "Chips", "rounded-chip"],
          ].map(([n, label, cls]) => (
            <div key={label} className={cx("flex h-[72px] w-[112px] flex-col items-center justify-center border border-line bg-surface", cls)}>
              <span className="type-body-strong text-ink">{n}</span>
              <span className="type-caption text-ink-2">{label}</span>
            </div>
          ))}
          <div className="flex h-[72px] w-[200px] items-center justify-center rounded-card border border-line bg-surface type-caption text-ink-2">
            Card · 1 px line
          </div>
          <div className="flex h-[72px] w-[200px] items-center justify-center rounded-box border-[1.5px] border-line-strong bg-surface type-caption text-ink-2">
            Question box · 1.5 px line-strong
          </div>
        </div>
      </Section>

      <Section title="Icons">
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-4 gap-y-3">
          {ICON_NAMES.map((name) => (
            <li key={name} className="flex items-center gap-2.5 type-caption text-ink-2">
              <Icon name={name} size={18} className="shrink-0 text-ink" />
              {name}
            </li>
          ))}
        </ul>
      </Section>

      {/* One h1 per page: the second half of the kit is a heading one level down. */}
      <h2 className="type-display-m text-ink">Components</h2>

      <Section title="Header">
        {/* A static showcase: inert, so the four demo navs are not extra "Main" landmarks beside the page header. */}
        <div inert aria-hidden="true" className="-mx-6 flex flex-col gap-4 max-md:-mx-4 md:-mx-14">
          <Header variant="home" />
          <Header variant="inner" active="answers" />
          <Header variant="working" />
          <Header variant="inner" mobile="answer" sharePath="/r/demo" />
        </div>
        <div className="flex items-center gap-6">
          <LogoMark />
          <LogoMark size={20} />
        </div>
      </Section>

      <Section title="Footer">
        <div className="-mx-6 rounded-card max-md:-mx-4 md:-mx-14">
          <Footer />
        </div>
      </Section>

      <Section title="Buttons">
        <div className="grid grid-cols-[110px_repeat(5,max-content)] items-center justify-items-start gap-x-8 gap-y-4 overflow-x-auto max-md:grid-cols-[90px_repeat(5,max-content)]">
          <span />
          {["Default", "Hover", "Pressed", "Disabled", "Loading"].map((s) => (
            <Label key={s}>{s}</Label>
          ))}
          <Label>Primary</Label>
          <Button variant="primary">Get answer</Button>
          <Button variant="primary" className="bg-accent-hover!">
            Get answer
          </Button>
          <Button variant="primary" className="bg-accent-hover! shadow-pressed!">
            Get answer
          </Button>
          <Button variant="primary" disabled>
            Get answer
          </Button>
          <Button variant="primary" loading>
            Get answer
          </Button>
          <Label>Primary-L</Label>
          <Button variant="primary" size="lg">
            Get answer
          </Button>
          <Button variant="primary" size="lg" className="bg-accent-hover!">
            Get answer
          </Button>
          <Button variant="primary" size="lg" className="bg-accent-hover! shadow-pressed!">
            Get answer
          </Button>
          <Button variant="primary" size="lg" disabled>
            Get answer
          </Button>
          <Button variant="primary" size="lg" loading>
            Get answer
          </Button>
          <Label>Secondary</Label>
          <Button icon="plus">New question</Button>
          <Button icon="plus" className="border-ink-3!">
            New question
          </Button>
          <Button icon="plus" className="bg-sunken!">
            New question
          </Button>
          <Button icon="plus" disabled>
            New question
          </Button>
          <span />
          <Label>Secondary · small</Label>
          <Button size="sm" icon="copy">
            Copy id
          </Button>
          <span />
          <span />
          <span />
          <span />
          <Label>Quiet</Label>
          <Button variant="quiet" icon="pencil">
            Edit question
          </Button>
          <Button variant="quiet" icon="pencil" className="bg-sunken!">
            Edit question
          </Button>
          <Button variant="quiet" icon="pencil" className="bg-sunken! text-ink!">
            Edit question
          </Button>
          <span />
          <span />
          <Label>Link</Label>
          <ButtonLink href="/briefs">Your answers</ButtonLink>
          <ButtonLink href="/briefs" className="underline! underline-offset-4!">
            Your answers
          </ButtonLink>
          <ButtonLink href="/briefs" className="text-accent-hover!">
            Your answers
          </ButtonLink>
          <span />
          <span />
          <Label>Icon button</Label>
          <IconButton label="More" icon="ellipsis" />
          <IconButton label="More" icon="ellipsis" className="bg-sunken!" />
          <span />
          <span />
          <span />
          <Label>Icon button · mobile</Label>
          <IconButton label="Menu" icon="menu" size="lg" />
          <IconButton label="Menu" icon="menu" size="lg" className="bg-sunken!" />
          <span />
          <span />
          <span />
        </div>
      </Section>

      <Section title="Chips and tags">
        <div className="flex flex-wrap gap-3">
          <Chip>Chip</Chip>
          <Chip className="border-accent-soft! bg-accent-soft! text-accent-ink!">Chip · hover</Chip>
          <Chip variant="go">Go</Chip>
          <Chip variant="filter">Places</Chip>
          <Chip variant="filter" on>
            All
          </Chip>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {TAGS.map((t) => (
            <Tag key={t} preset={t} />
          ))}
          <Tag tone="accent">Strong</Tag>
          <Tag tone="chart">Moderate</Tag>
          <Tag tone="second">Thin</Tag>
        </div>
      </Section>

      <div className="grid gap-10 lg:grid-cols-[240px_minmax(0,1fr)_minmax(0,1fr)]">
        <Section title="Topic tiles and tags">
          <div className="flex flex-col gap-4">
            {TOPIC_KEYS.map((t) => (
              <div key={t} className="flex items-center gap-4">
                <TopicTile topic={t} size={20} />
                <TopicTile topic={t} size={24} />
                <TopicTile topic={t} size={28} />
                <TopicTag topic={t} />
              </div>
            ))}
          </div>
          <Label>Toast</Label>
          <div className="flex items-center gap-4">
            <Toast>Link copied</Toast>
            <ToastDemo />
          </div>
        </Section>
        <Section title="Monograms">
          <div className="grid grid-cols-[70px_repeat(5,max-content)] items-center gap-x-5 gap-y-4">
            {MONO_ROWS.map((row) => (
              <MonoRow key={row.palette} palette={row.palette} name={row.name} />
            ))}
          </div>
        </Section>
        <Section title="Confidence">
          <div className="flex flex-wrap items-start gap-6">
            <ConfidenceDemo />
            <ConfidencePopoverStatic />
          </div>
        </Section>
      </div>

      <Section title="Segmented">
        <SegmentedDemo />
      </Section>

      <Section title="InlineState">
        <div className="flex max-w-[880px] flex-col gap-4">
          <Label>neutral · paused</Label>
          <InlineState action={<Button variant="primary">Your answers</Button>}>
            New questions reopen at 8:00 pm your time. Answers you already have still open.
          </InlineState>
          <Label>caution · partial</Label>
          <InlineState tone="caution" action={<Button variant="primary" trailing="rotate-ccw">Try again</Button>}>
            The evidence is here, but the analysis ran out of time to conclude.
          </InlineState>
          <Label>danger · failed</Label>
          <InlineState tone="danger" action={<Button variant="primary" trailing="rotate-ccw">Try again</Button>}>
            This answer couldn&apos;t be finished. Please try again.
          </InlineState>
          <Label>neutral · reconnecting</Label>
          <InlineState icon="wifi-off" action={<Button icon="rotate-ccw">Reload</Button>}>
            Live updates stopped. Reload to catch up.
          </InlineState>
        </div>
      </Section>

      <Section title="Key number">
        {(["default", "draft", "selected"] as const).map((state) => (
          <div key={state} className="flex flex-col gap-2">
            <Label>{state}</Label>
            <KeyNumberRow state={state} />
          </div>
        ))}
      </Section>

      <Section title="Chart card">
        <div className="grid gap-6 xl:grid-cols-2">
          <ChartCardDemo />
          <ChartCardDemo draft />
        </div>
      </Section>

      <Section title="Card">
        <div className="grid gap-6 md:grid-cols-3">
          <Card>
            <CardTitle icon="list-checks">Next steps</CardTitle>
            <p className="type-body text-ink-2">Card base: surface, 1 px line, r16, shadow-xs, padding 24.</p>
          </Card>
          <Card interactive tabIndex={0}>
            <CardTitle icon="file-text" as="h3">
              Interactive card
            </CardTitle>
            <p className="type-body text-ink-2">Line-strong border and shadow-md on hover.</p>
          </Card>
          <Card>
            <CardTitle icon="chart-bar">Loading and no data</CardTitle>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Hatch label="No data after Sep 2025" className="h-20" />
            </div>
          </Card>
        </div>
      </Section>

      <Section title="PageHead">
        <div className="flex max-w-[1128px] flex-col gap-10">
          <PageHead
            topic="brands"
            questionAs="p"
            eyebrow="Brands & investing · Real competitors · Data as of 23 Oct 2026"
            mobileEyebrow="Brands & investing · 23 Oct 2026"
            question="Lumen Drinks: is its audience a moat or a niche? Who does it really compete with?"
            actions={
              <>
                <Button icon="shield-check">How we know</Button>
                <Button icon="share-2">Share</Button>
                <IconButton label="More" icon="ellipsis" />
              </>
            }
          />
          <PageHead
            topic="brands"
            questionAs="p"
            eyebrow="Brands & investing · Real competitors"
            question="Lumen Drinks: is its audience a moat or a niche? Who does it really compete with?"
            actions={
              <Button variant="quiet" icon="square">
                Stop
              </Button>
            }
            mobileActions={
              <Button variant="quiet" icon="square">
                Stop
              </Button>
            }
          />
          <PageHead
            topic="brands"
            questionAs="p"
            eyebrow="Brands & investing · Compare two brands · Data as of 23 Oct 2026"
            question="Lumen Drinks vs Polar Orchard: whose audience is stronger, and where does each one win?"
            compare={{ subject: "Lumen Drinks", second: "Polar Orchard" }}
            actions={
              <>
                <Button icon="shield-check">How we know</Button>
                <Button icon="share-2">Share</Button>
                <IconButton label="More" icon="ellipsis" />
              </>
            }
          />
          <PageHead topic={null} questionAs="p" eyebrow="" question="Reading your question…" />
        </div>
      </Section>

      <Section title="Drawer shell">
        <div>
          <DrawerDemo />
        </div>
      </Section>

      <Section title="Form fields">
        <div className="grid max-w-[880px] gap-6 md:grid-cols-3">
          <Input label="Name" placeholder="A brand, artist or place" />
          <Select label="Type" defaultValue="brand">
            <option value="brand">Brand</option>
            <option value="artist">Artist</option>
          </Select>
          <div className="flex items-end pb-3">
            <Checkbox defaultChecked>Show hidden gems</Checkbox>
          </div>
        </div>
      </Section>
    </main>
  );
}

function MonoRow({ palette, name }: { palette: MonogramPalette; name: string }) {
  return (
    <>
      <Label>{palette}</Label>
      {MONO_SIZES.map((s) => (
        <Monogram key={s} name={name} size={s} palette={palette} />
      ))}
    </>
  );
}
