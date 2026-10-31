// The component library: icons, buttons, chips, tags, topics, monograms, confidence, segmented, inline
// states, cards, key numbers and the chart card shell. Invented names only.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, ButtonLink, IconButton } from "../../components/ui/button";
import { Card, CardTitle } from "../../components/ui/card";
import { ChartCard, ChartTable } from "../../components/ui/chart-card";
import { Chip, ChipLink } from "../../components/ui/chip";
import { CONFIDENCE_LABEL, ConfidenceChip, loweredByText } from "../../components/ui/confidence";
import { trapTarget } from "../../components/ui/drawer-shell";
import { ICON_NAMES, Icon, isIconName, Spinner } from "../../components/ui/icons";
import { InlineState } from "../../components/ui/inline-state";
import { KeyNumber } from "../../components/ui/key-number";
import { Monogram, monogramInitials, monogramPalette } from "../../components/ui/monogram";
import { Segmented, segmentedKeyMove } from "../../components/ui/segmented";
import { Hatch } from "../../components/ui/skeleton";
import { Tag, TAG_PRESETS } from "../../components/ui/tag";
import { Toast } from "../../components/ui/toast";
import { TOPICS, TopicTag, TopicTile, topicForPillar } from "../../components/ui/topic";

const html = renderToStaticMarkup;

describe("icons", () => {
  it("carries the whole Lucide set of the design", () => {
    for (const name of [
      "plus",
      "share-2",
      "table-2",
      "circle-play",
      "shield-check",
      "badge-check",
      "receipt",
      "loader-circle",
      "circle-question-mark",
      "wifi-off",
      "shopping-bag",
      "glass-water",
    ]) {
      expect(isIconName(name), name).toBe(true);
    }
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(64);
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
    expect(isIconName("toString")).toBe(false);
  });

  it("draws a 24-unit, 2-unit stroke icon, decorative unless titled", () => {
    const plain = html(<Icon name="check" />);
    expect(plain).toContain('viewBox="0 0 24 24"');
    expect(plain).toContain('stroke-width="2"');
    expect(plain).toContain('aria-hidden="true"');
    expect(plain).toContain('width="16"');
    const titled = html(<Icon name="check" title="Checked" size={20} />);
    expect(titled).toContain('role="img"');
    expect(titled).toContain("<title>Checked</title>");
  });

  it("spins the loader only when motion is allowed", () => {
    expect(html(<Spinner />)).toContain("motion-safe:animate-spin");
  });
});

describe("buttons", () => {
  it("primary is the accent with a trailing arrow; loading reads Reading…", () => {
    const primary = html(<Button variant="primary">Get answer</Button>);
    expect(primary).toContain("bg-accent");
    expect(primary).toContain("h-9");
    expect(primary).toContain("rounded-sm");
    expect(primary).toContain('data-icon="arrow-right"');
    const loading = html(
      <Button variant="primary" size="lg" loading>
        Get answer
      </Button>,
    );
    expect(loading).toContain("Reading…");
    expect(loading).toContain('data-icon="loader-circle"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("h-11");
  });

  it("a disabled primary drops its icons", () => {
    const off = html(
      <Button variant="primary" disabled icon="plus">
        Get answer
      </Button>,
    );
    expect(off).toContain("disabled");
    expect(off).not.toContain("data-icon");
  });

  it("secondary leads with an icon; trailing text that is not an icon name stays text", () => {
    const sec = html(<Button icon="plus">New question</Button>);
    expect(sec).toContain('data-icon="plus"');
    expect(sec).toContain("border-line-strong");
    expect(html(<Button trailing="⌘↵">Run</Button>)).toContain("⌘↵");
    expect(html(<Button variant="primary" trailing={null}>Go</Button>)).not.toContain("data-icon");
  });

  it("ButtonLink defaults to the accent link with an arrow", () => {
    const link = html(<ButtonLink href="/briefs">Your answers</ButtonLink>);
    expect(link).toContain('href="/briefs"');
    expect(link).toContain("text-accent");
    expect(link).toContain('data-icon="arrow-right"');
  });

  it("a destructive button is the danger fill without an arrow", () => {
    const del = html(<Button variant="destructive" icon="x">Delete brief</Button>);
    expect(del).toContain("bg-danger");
    expect(del).not.toContain('data-icon="arrow-right"');
  });

  it("IconButton is square, named and 44 on phones", () => {
    const btn = html(<IconButton label="Menu" icon="menu" size="lg" />);
    expect(btn).toContain('aria-label="Menu"');
    expect(btn).toContain("rounded-sm");
    expect(btn).toContain("size-11");
  });
});

describe("chips and tags", () => {
  it("filter chips announce their state; go chips carry an arrow", () => {
    expect(html(<Chip variant="filter" on>Places</Chip>)).toContain('aria-pressed="true"');
    expect(html(<Chip variant="filter">Places</Chip>)).toContain('aria-pressed="false"');
    expect(html(<Chip>Ask this</Chip>)).not.toContain("aria-pressed");
    expect(html(<ChipLink href="/ask?q=x">Ask this</ChipLink>)).toContain('data-icon="arrow-right"');
  });

  it("tags have words, never colour alone", () => {
    for (const preset of Object.keys(TAG_PRESETS) as (keyof typeof TAG_PRESETS)[]) {
      expect(html(<Tag preset={preset} />)).toContain(TAG_PRESETS[preset].label);
    }
    expect(html(<Tag preset="hidden-gem" />)).toContain("text-second-ink");
    expect(html(<Tag preset="recording" />)).toContain('data-icon="circle-play"');
    expect(html(<Tag tone="accent">Strong</Tag>)).toContain("bg-accent");
  });
});

describe("topics", () => {
  it("maps each desk to its topic", () => {
    expect(topicForPillar("investment").label).toBe("Brands & investing");
    expect(topicForPillar("location").key).toBe("places");
    expect(topicForPillar("marketing").icon).toBe("ticket");
    expect(topicForPillar("audience").key).toBe("audiences");
    expect(Object.values(TOPICS).map((t) => t.pillar).sort()).toEqual(["audience", "investment", "location", "marketing"]);
  });

  it("draws tiles in the topic's soft fill and ink", () => {
    const tile = html(<TopicTile topic="places" size={28} />);
    expect(tile).toContain("bg-topic-places-soft");
    expect(tile).toContain('data-icon="map-pin"');
    expect(html(<TopicTag topic="tours" label="Sponsors & tours · Austin" />)).toContain("Sponsors &amp; tours · Austin");
  });
});

describe("monograms", () => {
  it("takes initials as the design says", () => {
    expect(monogramInitials("Lumen Drinks")).toBe("LD");
    expect(monogramInitials("The Juniper Hall")).toBe("JH");
    expect(monogramInitials("A Quiet Harbor")).toBe("QH");
    expect(monogramInitials("Kelpwise")).toBe("KE");
    expect(monogramInitials("7 Mile Ridge Co")).toBe("MR");
    expect(monogramInitials("öland bakery")).toBe("ÖB");
    expect(monogramInitials("The")).toBe("TH");
    expect(monogramInitials("")).toBe("");
  });

  it("gives the same name the same neutral everywhere", () => {
    expect(monogramPalette("Cove Kitchen")).toBe(monogramPalette("  cove kitchen "));
    const seen = new Set(["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet"].map(monogramPalette));
    expect(seen.size).toBeGreaterThan(1);
    for (const p of seen) expect(["mono-1", "mono-2", "mono-3", "mono-4"]).toContain(p);
  });

  it("renders the subject palette and sizes", () => {
    const m = html(<Monogram name="Lumen Drinks" size={56} palette="subject" />);
    expect(m).toContain("bg-accent-soft");
    expect(m).toContain("size-14");
    expect(m).toContain(">LD<");
  });
});

describe("confidence", () => {
  it("labels every band and joins what lowered it", () => {
    expect(CONFIDENCE_LABEL.MED).toBe("Medium confidence");
    expect(CONFIDENCE_LABEL.insufficient_evidence).toBe("Not enough data");
    expect(loweredByText([])).toBeNull();
    expect(loweredByText(["older trend window.", " few peers "])).toBe("Lowered by: older trend window; few peers.");
  });

  it("a band chip opens a popover; not enough data is plain", () => {
    const high = html(<ConfidenceChip level="HIGH" />);
    expect(high).toContain('aria-haspopup="dialog"');
    expect(high).toContain("bg-good");
    expect(high).toContain('data-icon="chevron-down"');
    const none = html(<ConfidenceChip level="insufficient_evidence" />);
    expect(none).not.toContain("aria-haspopup");
    expect(none).not.toContain("chevron-down");
  });
});

describe("segmented", () => {
  it("moves with arrows, Home and End, and wraps", () => {
    expect(segmentedKeyMove("ArrowRight", 1, 2)).toBe(0);
    expect(segmentedKeyMove("ArrowLeft", 0, 4)).toBe(3);
    expect(segmentedKeyMove("End", 0, 4)).toBe(3);
    expect(segmentedKeyMove("Home", 2, 4)).toBe(0);
    expect(segmentedKeyMove("Enter", 0, 4)).toBeNull();
  });

  const OPTIONS = [
    { value: "chart", label: "Chart" },
    { value: "table", label: "Table" },
  ] as const;

  it("is a radiogroup with one tab stop", () => {
    const out = html(<Segmented label="View" options={OPTIONS} value="table" onChange={() => undefined} />);
    expect(out).toContain('role="radiogroup"');
    expect(out).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*tabindex="0"[^>]*>Table/);
    expect(out).toMatch(/aria-checked="false"[^>]*tabindex="-1"[^>]*>Chart/);
  });

  it("is a tablist whose tabs control panels", () => {
    const out = html(<Segmented label="How we know" kind="tablist" idPrefix="hk" options={OPTIONS} value="chart" onChange={() => undefined} />);
    expect(out).toContain('role="tablist"');
    expect(out).toContain('id="hk-tab-chart"');
    expect(out).toContain('aria-controls="hk-panel-chart"');
    expect(out).toContain('aria-selected="true"');
  });
});

describe("inline state, cards, toast, hatch", () => {
  it("puts one icon, one message and one action in the tone's fill", () => {
    const out = html(
      <InlineState tone="caution" action={<button type="button">Try again</button>}>
        Ran out of time.
      </InlineState>,
    );
    expect(out).toContain("bg-caution-soft");
    expect(out).toContain('data-icon="triangle-alert"');
    expect(out).toContain("Try again");
  });

  it("cards are surface, line, r16, shadow-xs; titles are headings", () => {
    const out = html(
      <Card>
        <CardTitle icon="list-checks">Next steps</CardTitle>
      </Card>,
    );
    expect(out).toContain("rounded-card");
    expect(out).toContain("border-line");
    expect(out).not.toContain("shadow-md");
    expect(out).toMatch(/<h2[^>]*>Next steps<\/h2>/);
    expect(html(<Card selected />)).toContain('data-selected="true"');
  });

  it("the toast is ink with a check; missing data reads No data", () => {
    const t = html(<Toast>Link copied</Toast>);
    expect(t).toContain("bg-ink");
    expect(t).toContain('data-icon="check"');
    expect(html(<Hatch />)).toContain("No data");
    expect(html(<Hatch />)).toContain("bg-hatch");
  });
});

describe("key number", () => {
  it("shows Source when it can open, the Draft tag while live", () => {
    const live = html(<KeyNumber value="0.84 match" label="Closest audience" context="Pinecone Soap Co." onSource={() => undefined} />);
    expect(live).toContain('aria-label="Source of Closest audience"');
    expect(live).toContain("type-number-l");
    const draft = html(<KeyNumber value="0.84 match" label="Closest audience" draft onSource={() => undefined} />);
    expect(draft).toContain("Draft");
    expect(draft).not.toContain("Source of");
  });

  it("draws the name and split variants", () => {
    const name = html(<KeyNumber variant="name" value="Ridgeline Lager" label="Best fit · beer" />);
    expect(name).toContain(">RL<");
    const split = html(
      <KeyNumber
        variant="split"
        label="Cities where it ranks first"
        sides={[
          { name: "Lumen", value: "4", tone: "subject" },
          { name: "Polar", value: "0", tone: "second" },
        ]}
      />,
    );
    expect(split).toContain("text-accent-ink");
    expect(split).toContain("text-second-ink");
  });
});

describe("chart card", () => {
  it("has kind, title, legend, the view switch, Source and the caption", () => {
    const out = html(
      <ChartCard
        kind="Closest audiences"
        title="A soap brand sits closest."
        legend={[{ label: "Outside its category", tone: "accent" }]}
        onSource={() => undefined}
        caption="Shared taste, not shared customers."
        table={<ChartTable label="Closest audiences" columns={[{ label: "Brand" }, { label: "Match", numeric: true }]} rows={[["Pinecone Soap Co.", "0.84"]]} />}
      >
        <div role="img" aria-label="Closest audiences" />
      </ChartCard>,
    );
    expect(out).toContain("Closest audiences");
    expect(out).toMatch(/<h3[^>]*>A soap brand sits closest.<\/h3>/);
    expect(out).toContain("Outside its category");
    expect(out).toContain('role="radiogroup"');
    expect(out).toContain('data-icon="receipt"');
    expect(out).toContain("Shared taste, not shared customers.");
    expect(out).toContain('data-view="chart"');
  });

  it("renders a real table in the Table view and hides the legend", () => {
    const out = html(
      <ChartCard
        kind="K"
        title="T"
        view="table"
        legend={[{ label: "Legend item", tone: "accent" }]}
        table={<ChartTable label="T" columns={[{ label: "Brand" }, { label: "Match", numeric: true }]} rows={[["Pinecone Soap Co.", "0.84"]]} />}
      >
        <div>plot</div>
      </ChartCard>,
    );
    expect(out).toContain('<th scope="col"');
    expect(out).toContain('<th scope="row"');
    expect(out).not.toContain("Legend item");
    expect(out).not.toContain(">plot<");
  });

  it("a draft chart shows the Draft tag and a disabled Source", () => {
    const out = html(
      <ChartCard kind="K" title="T" draft>
        <div />
      </ChartCard>,
    );
    expect(out).toContain("Draft");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>/);
  });
});

describe("drawer focus trap", () => {
  it("wraps Tab at the ends and leaves the middle to the browser", () => {
    const stops = ["a", "b", "c"];
    expect(trapTarget(stops, "c", false)).toBe("a");
    expect(trapTarget(stops, "a", true)).toBe("c");
    expect(trapTarget(stops, "b", false)).toBeNull();
    expect(trapTarget(stops, null, false)).toBe("a");
    expect(trapTarget([], null, false)).toBeNull();
  });
});
