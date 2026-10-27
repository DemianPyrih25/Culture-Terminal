import type { ReactNode } from "react";
import { cx } from "./cx";
import { Icon, type IconName } from "./icons";

/**
 * Dot and text colours: good (Ready, Instant), muted (Draft), second (Hidden gem, Few rivals nearby),
 * accent (Outside the category, New here), chart (Moderate), caution, danger.
 */
export type TagTone = "good" | "muted" | "second" | "accent" | "chart" | "caution" | "danger";

const DOT: Readonly<Record<TagTone, string>> = {
  good: "bg-good",
  muted: "bg-ink-3",
  second: "bg-second",
  accent: "bg-accent",
  chart: "bg-chart-muted",
  caution: "bg-caution",
  danger: "bg-danger",
};

const TEXT: Readonly<Record<TagTone, string>> = {
  good: "text-ink-2",
  muted: "text-ink-2",
  second: "text-second-ink",
  accent: "text-ink-2",
  chart: "text-ink-2",
  caution: "text-caution-ink",
  danger: "text-danger-ink",
};

export type TagPreset =
  | "ready"
  | "draft"
  | "hidden-gem"
  | "few-rivals"
  | "outside-category"
  | "new-here"
  | "instant"
  | "recording";

/** The tags the design names, with their words. */
export const TAG_PRESETS: Readonly<Record<TagPreset, { tone: TagTone; label: string; icon?: IconName }>> = {
  ready: { tone: "good", label: "Ready" },
  draft: { tone: "muted", label: "Draft" },
  "hidden-gem": { tone: "second", label: "Hidden gem" },
  "few-rivals": { tone: "second", label: "Few rivals nearby" },
  "outside-category": { tone: "accent", label: "Outside the category" },
  "new-here": { tone: "accent", label: "New here" },
  instant: { tone: "good", label: "Instant" },
  recording: { tone: "muted", label: "Recording", icon: "circle-play" },
};

export type TagProps = { className?: string } & (
  | { preset: TagPreset; tone?: never; icon?: never; children?: never }
  | {
      preset?: never;
      tone?: TagTone;
      /** A 14 px icon in place of the dot. */
      icon?: IconName;
      children: ReactNode;
    }
);

/** C/Tag: an 8 px dot (or a 14 px icon) and 13/500 text, gap 6. Colour is never the only signal. */
export function Tag(props: TagProps) {
  const { className } = props;
  const spec: { tone: TagTone; icon?: IconName; label: ReactNode } =
    props.preset !== undefined ? TAG_PRESETS[props.preset] : { tone: props.tone ?? "muted", icon: props.icon, label: props.children };
  return (
    <span
      data-tag={props.preset}
      className={cx("inline-flex shrink-0 items-center gap-1.5 type-label whitespace-nowrap", TEXT[spec.tone], className)}
    >
      {spec.icon ? (
        <Icon name={spec.icon} size={14} className="shrink-0 text-ink-2" />
      ) : (
        <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", DOT[spec.tone])} />
      )}
      <span>{spec.label}</span>
    </span>
  );
}
