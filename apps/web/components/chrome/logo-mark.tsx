import { cx } from "../ui/cx";

/**
 * The mark: four map tiles (2×2), read like a lift map. Three steps of ledger blue for the measured areas
 * and one warm tile for the spot worth a look.
 */
const TILES = ["#1d3e9e", "#9fb2e0", "#4f6fc0", "#c9792b"] as const;

export function LogoMark({ size = 22, className }: { size?: 20 | 22 | 24 | 32; className?: string }) {
  const gap = size >= 32 ? 3 : 2;
  const square = (size - gap) / 2;
  const r = size >= 32 ? 3 : 2;
  const at = [
    [0, 0],
    [square + gap, 0],
    [0, square + gap],
    [square + gap, square + gap],
  ] as const;
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cx("shrink-0", className)}>
      {at.map(([x, y], i) => (
        <rect key={i} x={x} y={y} width={square} height={square} rx={r} fill={TILES[i]} />
      ))}
    </svg>
  );
}

/** The app mark beside the wordmark: the same four tiles, so the sidebar, sign-in and landing match. */
export function InitialMark({ size = 22, className }: { size?: 22 | 24; className?: string }) {
  return <LogoMark size={size} className={className} />;
}
