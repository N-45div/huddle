import { useState } from "react";
import type { View } from "../types.ts";

/**
 * Bar, line and part-to-whole charts, drawn as SVG from a checked view: no chart library, no code from a
 * model. Every value can be reached with the keyboard and says what it is, and "Show the numbers" gives
 * the same values as a table.
 */

export type ChartSpec = Extract<View, { kind: "bar_chart" | "line_chart" | "part_to_whole" }>;

const WIDTH = 640;
const HEIGHT = 300;
const PAD = { top: 18, right: 16, bottom: 60, left: 60 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;
const CURRENCIES = new Set(["$", "€", "£", "₹", "¥"]);

/** A value with its unit: "$1,200", "71.2 kg", "40%"; `fixed` always shows the decimals ("$46.00"). */
export function withUnit(value: number, unit?: string, decimals = 2, fixed = false): string {
  const number = value.toLocaleString(undefined, { maximumFractionDigits: decimals, ...(fixed ? { minimumFractionDigits: decimals } : {}) });
  if (!unit) return number;
  if (CURRENCIES.has(unit)) return value < 0 ? `-${unit}${number.slice(1)}` : `${unit}${number}`;
  return unit === "%" ? `${number}%` : `${number} ${unit}`;
}

/** Round axis ticks from min to max. */
function ticks(min: number, max: number, count = 5): number[] {
  if (min === max) return [min];
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ?? raw;
  const first = Math.floor(min / step) * step;
  const out: number[] = [];
  for (let value = first; value <= max + step / 2; value += step) out.push(Number(value.toPrecision(12)));
  return out;
}

const short = (text: string, max = 14) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function Chart({ view }: { readonly view: ChartSpec }) {
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());
  const [focused, setFocused] = useState<{ series: number; index: number } | null>(null);
  const [numbers, setNumbers] = useState(false);
  const shown = view.series.map((series, index) => ({ ...series, index })).filter((series) => !hidden.has(series.index));

  const toggle = (index: number) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else if (view.series.length - next.size > 1) next.add(index);
      return next;
    });

  return (
    <div className="chart">
      {view.kind === "part_to_whole" ? <Donut view={view} focused={focused?.index ?? null} onFocus={(index) => setFocused(index === null ? null : { series: 0, index })} /> : <Axes view={view} shown={shown} focused={focused} onFocus={setFocused} />}
      <div className="chart-tools">
        {view.kind !== "part_to_whole" && view.series.length > 1 && (
          <div className="chart-legend" role="group" aria-label="Series shown">
            {view.series.map((series, index) => (
              <button key={series.name} type="button" className={`legend-key series-${index % 6}`} aria-pressed={!hidden.has(index)} onClick={() => toggle(index)}>
                <span className="legend-swatch" aria-hidden="true" />
                {series.name}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="btn btn-sm btn-ghost" aria-expanded={numbers} onClick={() => setNumbers((open) => !open)}>
          {numbers ? "Hide the numbers" : "Show the numbers"}
        </button>
      </div>
      {numbers && (
        <div className="view-table-wrap" tabIndex={0}>
          <table className="view-table">
            <thead>
              <tr>
                <th scope="col" />
                {view.series.map((series) => (
                  <th key={series.name} scope="col">
                    {series.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.labels.map((label, row) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  {view.series.map((series) => (
                    <td key={series.name}>{withUnit(series.values[row] ?? 0, view.unit)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Axes({
  view,
  shown,
  focused,
  onFocus,
}: {
  readonly view: ChartSpec;
  readonly shown: readonly { readonly name: string; readonly values: readonly number[]; readonly index: number }[];
  readonly focused: { series: number; index: number } | null;
  readonly onFocus: (point: { series: number; index: number } | null) => void;
}) {
  const values = shown.flatMap((series) => series.values);
  const scale = ticks(Math.min(0, ...values), Math.max(0, ...values));
  const low = scale[0] ?? 0;
  const high = scale.at(-1) ?? 1;
  const y = (value: number) => PAD.top + PLOT_H - ((value - low) / (high - low || 1)) * PLOT_H;
  const band = PLOT_W / view.labels.length;
  const tilt = view.labels.length > 6;
  const barWidth = (band * 0.78) / Math.max(1, shown.length);
  const barX = (position: number, index: number) => PAD.left + band * index + band * 0.11 + barWidth * position;
  const xOf = (index: number) => PAD.left + (view.labels.length === 1 ? PLOT_W / 2 : (PLOT_W / (view.labels.length - 1)) * index);
  const point = (series: number, index: number, value: number) => ({
    tabIndex: 0,
    role: "img" as const,
    "aria-label": `${view.series.length > 1 ? `${view.series[series]?.name}, ` : ""}${view.labels[index] ?? ""}: ${withUnit(value, view.unit)}`,
    onFocus: () => onFocus({ series, index }),
    onBlur: () => onFocus(null),
    onMouseEnter: () => onFocus({ series, index }),
    onMouseLeave: () => onFocus(null),
  });
  const tip = (() => {
    if (!focused) return null;
    const position = shown.findIndex((series) => series.index === focused.series);
    const value = view.series[focused.series]?.values[focused.index];
    if (position < 0 || value === undefined) return null;
    const text = withUnit(value, view.unit);
    return view.kind === "bar_chart" ? { x: barX(position, focused.index) + barWidth / 2, y: Math.min(y(value), y(0)) - 6, text } : { x: xOf(focused.index), y: y(value) - 10, text };
  })();
  const active = (series: number, index: number) => focused?.series === series && focused.index === index;

  return (
    <svg className="chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="group" aria-label={view.title}>
      {scale.map((tick) => (
        <g key={tick} className="chart-grid">
          <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} />
          <text x={PAD.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
            {withUnit(tick, view.unit, 1)}
          </text>
        </g>
      ))}
      {view.labels.map((label, index) => {
        const x = PAD.left + band * index + band / 2;
        return (
          <text key={label} className="chart-label" x={x} y={HEIGHT - PAD.bottom + 16} textAnchor={tilt ? "end" : "middle"} transform={tilt ? `rotate(-35 ${x} ${HEIGHT - PAD.bottom + 16})` : undefined}>
            <title>{label}</title>
            {short(label)}
          </text>
        );
      })}
      {view.kind === "bar_chart"
        ? shown.map((series, position) =>
            series.values.map((value, index) => (
              <rect
                key={`${series.name}-${index}`}
                className={`chart-bar series-${series.index % 6}${active(series.index, index) ? " active" : ""}`}
                x={barX(position, index)}
                y={Math.min(y(value), y(0))}
                width={Math.max(1, barWidth - 2)}
                height={Math.max(1, Math.abs(y(value) - y(0)))}
                rx={2}
                {...point(series.index, index, value)}
              />
            )),
          )
        : shown.map((series) => (
            <g key={series.name} className={`series-${series.index % 6}`}>
              <polyline className="chart-line" points={series.values.map((value, index) => `${xOf(index)},${y(value)}`).join(" ")} />
              {series.values.map((value, index) => (
                <circle key={index} className={`chart-dot${active(series.index, index) ? " active" : ""}`} cx={xOf(index)} cy={y(value)} r={active(series.index, index) ? 6 : 4} {...point(series.index, index, value)} />
              ))}
            </g>
          ))}
      {tip && <ChartTip tip={tip} />}
    </svg>
  );
}

function ChartTip({ tip }: { readonly tip: { x: number; y: number; text: string } }) {
  const width = Math.max(40, tip.text.length * 7.5 + 14);
  const x = Math.min(Math.max(tip.x - width / 2, 2), WIDTH - width - 2);
  const y = Math.max(tip.y - 26, 2);
  return (
    <g className="chart-tip" aria-hidden="true">
      <rect x={x} y={y} width={width} height={22} rx={5} />
      <text x={x + width / 2} y={y + 11} textAnchor="middle" dominantBaseline="middle">
        {tip.text}
      </text>
    </g>
  );
}

function Donut({ view, focused, onFocus }: { readonly view: ChartSpec; readonly focused: number | null; readonly onFocus: (index: number | null) => void }) {
  const values = view.series[0]?.values ?? [];
  const total = values.reduce((sum, value) => sum + value, 0);
  const cx = 150;
  const cy = 150;
  const outer = 120;
  const inner = 72;
  let angle = -Math.PI / 2;
  const arcs = values.map((value, index) => {
    const sweep = total > 0 ? (value / total) * Math.PI * 2 : 0;
    const start = angle;
    angle += sweep;
    const end = angle - (sweep >= Math.PI * 2 ? 0.0001 : 0);
    const large = sweep > Math.PI ? 1 : 0;
    const at = (radius: number, theta: number) => `${cx + radius * Math.cos(theta)} ${cy + radius * Math.sin(theta)}`;
    const d = `M ${at(outer, start)} A ${outer} ${outer} 0 ${large} 1 ${at(outer, end)} L ${at(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${at(inner, start)} Z`;
    return { d, value, index, share: total > 0 ? value / total : 0 };
  });
  const active = focused === null ? null : arcs[focused];
  return (
    <div className="donut">
      <svg className="donut-svg" viewBox="0 0 300 300" role="group" aria-label={view.title}>
        {arcs.map((arc) => (
          <path
            key={arc.index}
            d={arc.d}
            className={`donut-part series-${arc.index % 6}${focused === arc.index ? " active" : ""}`}
            tabIndex={0}
            role="img"
            aria-label={`${view.labels[arc.index]}: ${withUnit(arc.value, view.unit)}, ${Math.round(arc.share * 100)}%`}
            onFocus={() => onFocus(arc.index)}
            onBlur={() => onFocus(null)}
            onMouseEnter={() => onFocus(arc.index)}
            onMouseLeave={() => onFocus(null)}
          />
        ))}
        <text x={cx} y={cy - 8} textAnchor="middle" className="donut-total">
          {active ? `${Math.round(active.share * 100)}%` : withUnit(total, view.unit, 0)}
        </text>
        <text x={cx} y={cy + 16} textAnchor="middle" className="donut-caption">
          {active ? short(view.labels[active.index] ?? "", 16) : "in all"}
        </text>
      </svg>
      <ul className="donut-legend">
        {arcs.map((arc) => (
          <li key={arc.index} className={`series-${arc.index % 6}${focused === arc.index ? " active" : ""}`}>
            <span className="legend-swatch" aria-hidden="true" />
            <span className="donut-name">{view.labels[arc.index]}</span>
            <span className="donut-value">
              {withUnit(arc.value, view.unit)} · {Math.round(arc.share * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
