import type { Pillar } from "@ct/contracts";
import { cx } from "./cx";
import { Icon, type IconName } from "./icons";

/** The four topics of the design, one per desk (pillar). */
export type TopicKey = "brands" | "places" | "tours" | "audiences";

export interface Topic {
  key: TopicKey;
  /** "Brands & investing". */
  label: string;
  pillar: Pillar;
  icon: IconName;
}

export const TOPICS: Readonly<Record<TopicKey, Topic>> = {
  brands: { key: "brands", label: "Brands & investing", pillar: "investment", icon: "shopping-bag" },
  places: { key: "places", label: "Places", pillar: "location", icon: "map-pin" },
  tours: { key: "tours", label: "Sponsors & tours", pillar: "marketing", icon: "ticket" },
  audiences: { key: "audiences", label: "Audiences", pillar: "audience", icon: "users" },
};

/** Topics in display order. */
export const TOPIC_KEYS: readonly TopicKey[] = ["brands", "places", "tours", "audiences"];

const BY_PILLAR: Readonly<Record<Pillar, TopicKey>> = {
  investment: "brands",
  location: "places",
  marketing: "tours",
  audience: "audiences",
};

/** The topic of a desk. */
export function topicForPillar(pillar: Pillar): Topic {
  return TOPICS[BY_PILLAR[pillar]];
}

// Static class names, so Tailwind sees every one.
const TONE: Readonly<Record<TopicKey, { tile: string; ink: string }>> = {
  brands: { tile: "bg-topic-brands-soft text-topic-brands-ink", ink: "text-topic-brands-ink" },
  places: { tile: "bg-topic-places-soft text-topic-places-ink", ink: "text-topic-places-ink" },
  tours: { tile: "bg-topic-tours-soft text-topic-tours-ink", ink: "text-topic-tours-ink" },
  audiences: { tile: "bg-topic-audiences-soft text-topic-audiences-ink", ink: "text-topic-audiences-ink" },
};

/** Tile sizes: 20 (phones), 24 (eyebrows, r8) and 28 (cards). */
export type TopicTileSize = 20 | 24 | 28;

const TILE_SIZE: Readonly<Record<TopicTileSize, { box: string; icon: number }>> = {
  20: { box: "size-5 rounded-xs", icon: 12 },
  24: { box: "size-6 rounded-sm", icon: 14 },
  28: { box: "size-7 rounded-sm", icon: 14 },
};

export interface TopicTileProps {
  topic: TopicKey;
  size?: TopicTileSize;
  className?: string;
}

/** C/TopicTile: the topic's soft fill with its icon in topic ink. Decorative. */
export function TopicTile({ topic, size = 24, className }: TopicTileProps) {
  const s = TILE_SIZE[size];
  return (
    <span
      aria-hidden="true"
      data-topic={topic}
      className={cx("inline-flex shrink-0 items-center justify-center", s.box, TONE[topic].tile, className)}
    >
      <Icon name={TOPICS[topic].icon} size={s.icon} />
    </span>
  );
}

export interface TopicTagProps {
  topic: TopicKey;
  /** Replaces the topic's label, e.g. "Places · Austin". */
  label?: string;
  size?: TopicTileSize;
  className?: string;
}

/** C/TopicTag: the tile and the topic's label in 13/500 topic ink, gap 8. */
export function TopicTag({ topic, label, size = 24, className }: TopicTagProps) {
  return (
    <span className={cx("inline-flex items-center gap-2 type-label whitespace-nowrap", TONE[topic].ink, className)}>
      <TopicTile topic={topic} size={size} />
      <span>{label ?? TOPICS[topic].label}</span>
    </span>
  );
}
