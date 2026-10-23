// Line icons for Concept A (D36): 24-unit grid, 2-unit round strokes in currentColor, drawn at 14 px by
// default (A·C Components). Decorative unless given a `title`, which makes them role="img".
import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "search"
  | "check"
  | "cross"
  | "dash"
  | "arrow-right"
  | "chevron"
  | "link"
  | "download"
  | "external";

export type ChevronDirection = "up" | "down" | "left" | "right";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children" | "direction"> {
  /** Rendered width and height in px (default 14). */
  size?: number;
  /** Accessible name. Without it the icon is aria-hidden. */
  title?: string;
}

function Svg({ size = 14, title, strokeWidth = 2, children, ...rest }: IconProps & { children: ReactNode }) {
  const labelled = title !== undefined && title !== "";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...(labelled ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
      {...rest}
    >
      {labelled ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/** Magnifier: command field and search inputs. */
export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10.5" cy="10.5" r="7" />
      <path d="M15.5 15.5 21 21" />
    </Svg>
  );
}

/** Tick: confirmed priors, traced numbers, a checked box. */
export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
    </Svg>
  );
}

/** Cross: refuted priors, close buttons. */
export function CrossIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6 18 18M18 6 6 18" />
    </Svg>
  );
}

/** Dash: inconclusive, flat, no change. */
export function DashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12h14" />
    </Svg>
  );
}

/** Arrow: quiet links that go somewhere. */
export function ArrowRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 12h15M13 5.5l6.5 6.5-6.5 6.5" />
    </Svg>
  );
}

const CHEVRON_PATH: Record<ChevronDirection, string> = {
  down: "M6 9l6 6 6-6",
  up: "M6 15l6-6 6 6",
  left: "M15 6l-6 6 6 6",
  right: "M9 6l6 6-6 6",
};

/** Chevron: disclosures ("Why NN", "Show the N steps") and selects. Points down by default. */
export function ChevronIcon({ direction = "down", ...props }: IconProps & { direction?: ChevronDirection }) {
  return (
    <Svg {...props}>
      <path d={CHEVRON_PATH[direction]} />
    </Svg>
  );
}

/** Chain link: share or copy the brief's link. */
export function LinkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 14a4.5 4.5 0 0 0 6.36 0l3.18-3.18a4.5 4.5 0 0 0-6.36-6.36L11.6 6.04" />
      <path d="M14 10a4.5 4.5 0 0 0-6.36 0l-3.18 3.18a4.5 4.5 0 0 0 6.36 6.36l1.58-1.58" />
    </Svg>
  );
}

/** Page with a down arrow: export PDF. */
export function DownloadIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z" />
      <path d="M14 2.5V8h5.5" />
      <path d="M12 11.5v6M9 14.5l3 3 3-3" />
    </Svg>
  );
}

/** Box with an outward arrow: opens outside the brief (the method page, Qloo docs). */
export function ExternalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14.5 3.5h6v6M20.5 3.5 11 13" />
      <path d="M18.5 13.5v5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h5" />
    </Svg>
  );
}

const ICONS: Record<Exclude<IconName, "chevron">, (props: IconProps) => ReactNode> = {
  search: SearchIcon,
  check: CheckIcon,
  cross: CrossIcon,
  dash: DashIcon,
  "arrow-right": ArrowRightIcon,
  link: LinkIcon,
  download: DownloadIcon,
  external: ExternalIcon,
};

/** Any icon of the set by name; `chevron` points down. */
export function Icon({ name, ...props }: IconProps & { name: IconName }) {
  if (name === "chevron") return <ChevronIcon {...props} />;
  const Component = ICONS[name];
  return <Component {...props} />;
}

/** Every icon name, in gallery order. */
export const ICON_NAMES: readonly IconName[] = [
  "search",
  "check",
  "cross",
  "dash",
  "arrow-right",
  "chevron",
  "link",
  "download",
  "external",
];
