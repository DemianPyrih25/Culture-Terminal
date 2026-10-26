import type { CSSProperties, ReactNode } from "react";
import { KEY_COMPARATOR_TYPE, KEY_LABEL_TYPE, keySlotWidth, type OgCard, type OgKeyFigure, type OgPanel } from "./card";
import type { MiniLegend, MiniRow, MiniTone, MiniViz } from "./mini-viz";
import { labelTracking, OG_COLOR, OG_FONT, OG_FRAME, OG_SIZE } from "./tokens";

/**
 * The share card as next/og draws it (1200 × 630, Concept A): the top bar with the running head, the
 * question and the signal line on the left, the lead figure's mini viz and key figures on the right,
 * the receipt strip at the foot. Satori's subset of CSS: flex boxes, inline styles, inline SVG for
 * marks. Every string it prints comes from the card (lib/og/card.ts), already fitted to the fonts.
 */

const TONE: Readonly<Record<MiniTone, string>> = { data: OG_COLOR.data, data2: OG_COLOR.data2, negative: OG_COLOR.negative };

/** The plot area of the mini viz, in px. */
const VIZ = { width: OG_FRAME.right, height: 168 } as const;

const label = (color: string, size = 13): CSSProperties => ({
  fontFamily: OG_FONT.sans,
  fontWeight: 600,
  fontSize: size,
  letterSpacing: labelTracking(size),
  textTransform: "uppercase",
  color,
});

/** One line that ends in an ellipsis when it does not fit. */
const oneLine = (width: number | string): CSSProperties => ({
  display: "block",
  width,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
});

export function OgCardImage({ card }: { card: OgCard }) {
  return (
    <div
      style={{
        width: OG_SIZE.width,
        height: OG_SIZE.height,
        display: "flex",
        flexDirection: "column",
        background: OG_COLOR.paper,
        color: OG_COLOR.ink,
        fontFamily: OG_FONT.sans,
      }}
    >
      <TopBar head={card.head} />
      <div style={{ display: "flex", flex: 1, gap: OG_FRAME.gap, padding: `${OG_FRAME.top}px ${OG_FRAME.side}px ${OG_FRAME.bottom}px` }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: OG_FRAME.left, gap: 24 }}>
          <div
            style={{
              display: "block",
              lineClamp: card.question.lines,
              fontFamily: OG_FONT.serif,
              fontWeight: 500,
              fontSize: card.question.size,
              lineHeight: `${card.question.lineHeight}px`,
              color: OG_COLOR.ink,
            }}
          >
            {card.question.text}
          </div>
          <SignalLine signal={card.signal} />
        </div>
        <Panel panel={card.panel} />
      </div>
      <ReceiptStrip receipt={card.receipt} honesty={card.honesty} />
    </div>
  );
}

function TopBar({ head }: { head: OgCard["head"] }) {
  const parts: { text: string; color: string }[] = [
    ...(head.desk ? [{ text: head.desk, color: OG_COLOR.accent }] : []),
    ...(head.job ? [{ text: head.job, color: OG_COLOR.dim }] : []),
    { text: head.brief, color: OG_COLOR.dim },
    ...(head.date ? [{ text: head.date, color: OG_COLOR.dim }] : []),
  ];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: OG_FRAME.bar,
        padding: `0 ${OG_FRAME.side}px`,
        background: OG_COLOR.canvas,
        borderBottom: `1px solid ${OG_COLOR.line}`,
      }}
    >
      <div style={{ display: "flex", fontWeight: 600, fontSize: 15, letterSpacing: 3.6, color: OG_COLOR.ink }}>CULTURE TERMINAL</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, ...label(OG_COLOR.dim) }}>
        {parts.flatMap((p, i) => [
          ...(i > 0
            ? [
                <span key={`sep-${i}`} style={{ color: OG_COLOR.faint, letterSpacing: 0 }}>
                  ·
                </span>,
              ]
            : []),
          <span key={`part-${i}`} style={{ color: p.color }}>
            {p.text}
          </span>,
        ])}
      </div>
    </div>
  );
}

function SignalLine({ signal }: { signal: OgCard["signal"] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, ...label(OG_COLOR.dim) }}>
        <span>The answer</span>
        <span style={{ color: OG_COLOR.faint, letterSpacing: 0 }}>—</span>
        <span style={{ color: OG_COLOR.ink }}>{signal.tag}</span>
        {signal.marker ? (
          <span
            style={{
              display: "flex",
              border: `1px solid ${OG_COLOR.negative}`,
              padding: "1px 6px",
              fontFamily: OG_FONT.mono,
              fontWeight: 400,
              fontSize: 12,
              letterSpacing: 0.6,
              color: OG_COLOR.negative,
            }}
          >
            {signal.marker}
          </span>
        ) : null}
      </div>
      {signal.finding ? (
        <div style={{ ...oneLine(OG_FRAME.left), fontFamily: OG_FONT.serif, fontWeight: 600, fontSize: 36, lineHeight: "44px", color: OG_COLOR.ink }}>
          {signal.finding}
        </div>
      ) : null}
      {signal.conviction ? (
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={label(OG_COLOR.dim)}>Conviction</span>
          <span style={{ fontFamily: OG_FONT.serif, fontWeight: 500, fontSize: 24, color: OG_COLOR.ink }}>{signal.conviction.text}</span>
          <Meter position={signal.conviction.position} />
        </div>
      ) : null}
    </div>
  );
}

/** The conviction meter (A/Conviction strip): LOW · MEDIUM · HIGH bands, the score's marker. */
function Meter({ position }: { position: number }) {
  const w = 160;
  const at = Math.round(position * w);
  return (
    <svg width={w + 4} height={18} viewBox={`-2 0 ${w + 4} 18`}>
      <line x1={0} y1={9} x2={w} y2={9} stroke={OG_COLOR.lineStrong} strokeWidth={1} />
      <line x1={0} y1={9} x2={at} y2={9} stroke={OG_COLOR.accent} strokeWidth={2} />
      {[0.5, 0.75].map((t) => (
        <line key={t} x1={t * w} y1={5} x2={t * w} y2={13} stroke={OG_COLOR.lineStrong} strokeWidth={1} />
      ))}
      <line x1={at} y1={2} x2={at} y2={16} stroke={OG_COLOR.accent} strokeWidth={2} />
    </svg>
  );
}

// Right column -----------------------------------------------------------------------------------------

function Panel({ panel }: { panel: OgPanel | null }) {
  const frame: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    width: OG_FRAME.right,
    paddingTop: 14,
    borderTop: `1px solid ${OG_COLOR.lineStrong}`,
  };
  if (panel === null) return <div style={frame} />;
  if (panel.kind === "refusal") {
    return (
      <div style={{ ...frame, gap: 12 }}>
        <span style={label(OG_COLOR.negative, 12)}>Not answered</span>
        {panel.category ? <div style={{ display: "flex", fontFamily: OG_FONT.serif, fontWeight: 600, fontSize: 26, color: OG_COLOR.ink }}>{panel.category}</div> : null}
        <div style={{ display: "block", lineClamp: 5, fontSize: 16, lineHeight: "24px", color: OG_COLOR.text2 }}>{panel.message}</div>
        {panel.reframe ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
            <span style={label(OG_COLOR.accent, 12)}>Asked instead</span>
            <div style={{ display: "block", lineClamp: 4, fontSize: 16, lineHeight: "24px", color: OG_COLOR.ink }}>{panel.reframe}</div>
          </div>
        ) : null}
      </div>
    );
  }
  if (panel.kind === "key_figures") {
    return (
      <div style={{ ...frame, gap: 18 }}>
        <span style={label(OG_COLOR.accent, 12)}>Key figures</span>
        {panel.keyFigures.map((k, i) => (
          <KeyFigure key={i} figure={k} size={44} width={OG_FRAME.right} />
        ))}
      </div>
    );
  }
  const viz = panel.viz;
  const legend = viz.kind === "rows" || viz.kind === "lines" ? viz.legend : [];
  const keyWidth = keySlotWidth(panel.keyFigures.length);
  return (
    <div style={frame}>
      <span style={label(OG_COLOR.accent, 12)}>{`Figure ${panel.number}`}</span>
      <div style={{ display: "block", lineClamp: 2, marginTop: 6, fontFamily: OG_FONT.serif, fontWeight: 600, fontSize: 20, lineHeight: "26px", color: OG_COLOR.ink }}>
        {panel.title}
      </div>
      {legend.length > 0 ? <Legend items={legend} /> : null}
      <div style={{ display: "flex", flexDirection: "column", marginTop: 12 }}>
        <MiniVizView viz={viz} />
      </div>
      {viz.note ? <div style={{ ...oneLine(OG_FRAME.right), marginTop: 6, fontSize: 12, color: OG_COLOR.dim }}>{viz.note}</div> : null}
      <div style={{ display: "flex", flex: 1 }} />
      {panel.keyFigures.length > 0 ? (
        <div style={{ display: "flex", gap: OG_FRAME.keyGap, paddingTop: 12, borderTop: `1px solid ${OG_COLOR.line}` }}>
          {panel.keyFigures.map((k, i) => (
            <KeyFigure key={i} figure={k} size={30} width={keyWidth} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function KeyFigure({ figure, size, width }: { figure: OgKeyFigure; size: number; width: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", width, gap: 3 }}>
      <div style={{ display: "flex", fontFamily: OG_FONT.serif, fontWeight: 500, fontSize: size, lineHeight: `${size + 4}px`, color: OG_COLOR.ink }}>{figure.value}</div>
      <div style={{ ...oneLine(width), fontSize: KEY_LABEL_TYPE.size, lineHeight: "19px", color: OG_COLOR.text2 }}>{figure.label}</div>
      {figure.comparator ? <div style={{ ...oneLine(width), ...label(OG_COLOR.dim, KEY_COMPARATOR_TYPE.size) }}>{figure.comparator}</div> : null}
    </div>
  );
}

function Legend({ items }: { items: MiniLegend[] }) {
  return (
    <div style={{ display: "flex", gap: 16, marginTop: 10 }}>
      {items.map((item, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: OG_COLOR.text2 }}>
          <div style={{ display: "flex", width: 10, height: 10, background: TONE[item.tone] }} />
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

// Mini viz ----------------------------------------------------------------------------------------------

function MiniVizView({ viz }: { viz: MiniViz }): ReactNode {
  switch (viz.kind) {
    case "rows":
      return <RowsView rows={viz.rows} centre={viz.centre} />;
    case "grid":
      return <GridView viz={viz} />;
    case "scatter":
      return <ScatterView viz={viz} />;
    case "lines":
      return <LinesView viz={viz} />;
  }
}

function RowsView({ rows, centre }: { rows: MiniRow[]; centre: number | null }) {
  const labelW = 150;
  const valueW = rows.some((r) => r.value !== null) ? 92 : 0;
  const gap = 12;
  const trackW = VIZ.width - labelW - valueW - gap * (valueW > 0 ? 2 : 1);
  const rowH = Math.min(28, Math.floor(VIZ.height / Math.max(1, rows.length)));
  const mid = rowH / 2;
  const px = (t: number) => Math.round(4 + t * (trackW - 8));
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {rows.map((row, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap, height: rowH }}>
          <div style={{ ...oneLine(labelW), fontSize: 13, color: OG_COLOR.text2 }}>{row.label}</div>
          <svg width={trackW} height={rowH} viewBox={`0 0 ${trackW} ${rowH}`}>
            {centre === null ? (
              <line x1={px(0)} y1={mid} x2={px(1)} y2={mid} stroke={OG_COLOR.line} strokeWidth={1} />
            ) : (
              <line x1={px(centre)} y1={0} x2={px(centre)} y2={rowH} stroke={OG_COLOR.faint} strokeWidth={1} />
            )}
            {row.bar ? (
              <rect
                x={Math.min(px(row.bar.from), px(row.bar.to))}
                y={mid - 5}
                width={Math.max(2, Math.abs(px(row.bar.to) - px(row.bar.from)))}
                height={10}
                fill={TONE[row.bar.tone]}
              />
            ) : null}
            {row.dots.length === 2 ? (
              <line x1={px(row.dots[0]!.at)} y1={mid} x2={px(row.dots[1]!.at)} y2={mid} stroke={OG_COLOR.lineStrong} strokeWidth={2} />
            ) : null}
            {row.dots.map((d, j) => (
              <circle key={j} cx={px(d.at)} cy={mid} r={5} fill={TONE[d.tone]} />
            ))}
          </svg>
          {valueW > 0 ? (
            <div style={{ ...oneLine(valueW), textAlign: "right", fontSize: 13, color: row.value === null ? OG_COLOR.faint : OG_COLOR.ink }}>{row.value ?? ""}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** A cell's fill: the data colour at an opacity for its intensity. */
const heat = (v: number) => `rgba(28, 61, 110, ${(0.08 + v * 0.84).toFixed(3)})`;

function GridView({ viz }: { viz: Extract<MiniViz, { kind: "grid" }> }) {
  const labelW = 150;
  const n = Math.max(1, viz.cols.length);
  const cell = Math.min(40, Math.floor((VIZ.width - labelW - 12) / n));
  const cellH = Math.min(26, Math.floor((VIZ.height - 20) / Math.max(1, viz.rows.length)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", gap: 12, height: 18 }}>
        <div style={{ display: "flex", width: labelW }} />
        <div style={{ display: "flex" }}>
          {viz.cols.map((code, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                justifyContent: "center",
                width: cell,
                fontFamily: OG_FONT.mono,
                fontSize: 11,
                color: i === viz.targetCol ? OG_COLOR.accent : OG_COLOR.dim,
              }}
            >
              {code}
            </div>
          ))}
        </div>
      </div>
      {viz.rows.map((row, r) => (
        <div key={r} style={{ display: "flex", alignItems: "center", gap: 12, height: cellH }}>
          <div style={{ ...oneLine(labelW), fontSize: 13, fontWeight: row.target ? 600 : 400, color: row.target ? OG_COLOR.ink : OG_COLOR.text2 }}>{row.label}</div>
          <div style={{ display: "flex" }}>
            {row.cells.map((v, c) => (
              <div key={c} style={{ display: "flex", width: cell, height: cellH, padding: 1 }}>
                <div style={{ display: "flex", flex: 1, background: v === null ? OG_COLOR.canvas : heat(v) }} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ScatterView({ viz }: { viz: Extract<MiniViz, { kind: "scatter" }> }) {
  const w = VIZ.width;
  const h = VIZ.height - 36;
  const x = (t: number) => Math.round(6 + t * (w - 12));
  const y = (t: number) => Math.round(6 + t * (h - 12));
  const order = [...viz.points].sort((a, b) => (a.tone === "data" ? 1 : 0) - (b.tone === "data" ? 1 : 0));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ ...oneLine(w), height: 14, ...label(OG_COLOR.dim, 11) }}>{viz.yLabel}</div>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <rect x={0.5} y={0.5} width={w - 1} height={h - 1} fill="none" stroke={OG_COLOR.line} strokeWidth={1} />
        <line x1={x(viz.split.x)} y1={0} x2={x(viz.split.x)} y2={h} stroke={OG_COLOR.lineStrong} strokeWidth={1} />
        <line x1={0} y1={y(viz.split.y)} x2={w} y2={y(viz.split.y)} stroke={OG_COLOR.lineStrong} strokeWidth={1} />
        {order.map((p, i) => (
          <circle key={i} cx={x(p.x)} cy={y(p.y)} r={p.tone === "data" ? 5 : 3.5} fill={TONE[p.tone]} />
        ))}
      </svg>
      <div style={{ ...oneLine(w), height: 14, textAlign: "right", ...label(OG_COLOR.dim, 11) }}>{viz.xLabel}</div>
    </div>
  );
}

function LinesView({ viz }: { viz: Extract<MiniViz, { kind: "lines" }> }) {
  const w = VIZ.width;
  const h = VIZ.height - (viz.axes.length > 0 ? 22 : 4);
  const inset = viz.axes.length > 0 ? 28 : 6;
  const x = (t: number) => Math.round(inset + t * (w - 2 * inset));
  const y = (t: number) => Math.round(8 + t * (h - 16));
  /** A line's runs of consecutive points: a missing point breaks it. */
  const runs = (points: ({ x: number; y: number } | null)[]) => {
    const out: { x: number; y: number }[][] = [[]];
    for (const p of points) {
      if (p === null) out.push([]);
      else out[out.length - 1]!.push(p);
    }
    return out.filter((r) => r.length > 0);
  };
  const order = [...viz.lines].sort((a, b) => (a.tone === "data" ? 1 : 0) - (b.tone === "data" ? 1 : 0));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        {viz.axes.length > 1 ? (
          viz.axes.map((_, i) => <line key={i} x1={x(i / (viz.axes.length - 1))} y1={0} x2={x(i / (viz.axes.length - 1))} y2={h} stroke={OG_COLOR.line} strokeWidth={1} />)
        ) : (
          <line x1={0} y1={h - 0.5} x2={w} y2={h - 0.5} stroke={OG_COLOR.line} strokeWidth={1} />
        )}
        {order.flatMap((line, i) => {
          const strong = line.tone === "data";
          return runs(line.points).flatMap((run, j) => [
            <polyline
              key={`l-${i}-${j}`}
              points={run.map((p) => `${x(p.x)},${y(p.y)}`).join(" ")}
              fill="none"
              stroke={TONE[line.tone]}
              strokeWidth={strong ? 2.5 : 1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />,
            ...(viz.axes.length > 0 ? run.map((p, k) => <circle key={`d-${i}-${j}-${k}`} cx={x(p.x)} cy={y(p.y)} r={strong ? 4 : 3} fill={TONE[line.tone]} />) : []),
          ]);
        })}
      </svg>
      {viz.axes.length > 0 ? (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: OG_COLOR.dim }}>
          {viz.axes.map((a, i) => (
            <span key={i}>{a}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReceiptStrip({ receipt, honesty }: { receipt: string[]; honesty: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: OG_FRAME.strip,
        padding: `0 ${OG_FRAME.side}px`,
        background: OG_COLOR.canvas,
        borderTop: `1px solid ${OG_COLOR.line}`,
      }}
    >
      <div style={{ display: "flex", gap: 30, fontFamily: OG_FONT.mono, fontSize: 15, color: OG_COLOR.text2 }}>
        {receipt.map((item, i) => (
          <span key={i}>{item}</span>
        ))}
      </div>
      <div style={{ display: "flex", fontSize: 13, color: OG_COLOR.dim }}>{honesty}</div>
    </div>
  );
}
