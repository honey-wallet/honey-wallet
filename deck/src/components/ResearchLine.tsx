import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { useDeck } from '../deck/DeckContext';
import { useInView } from '../deck/useInView';
import { SCALE } from '../scale';
import './research.css';

/* A research-grade line chart that fills its container: real axes, direct
   end labels, an optional event marker and reference line, and a hover/touch
   readout. Sized in real pixels (no viewBox scaling) so text stays legible.
   <ResearchLine series={[{ name, tone: 'primary', points: [[x, y], …] }]}
     x={{ min, max, ticks: [{ at, label }] }} y={{ max: 40, ticks: [0, 10, 20] }} /> */
export type Series = {
  name: string;
  tone: 'primary' | 'ink';
  points: [number, number][];
  label?: string;
};

export default function ResearchLine({
  series,
  x,
  y,
  unit = '%',
  marker,
  reference,
  labelOf,
}: {
  series: Series[];
  x: { min: number; max: number; ticks: { at: number; label: string }[] };
  y: { max: number; ticks: number[] };
  unit?: string;
  marker?: { at: number; label: string };
  reference?: { at: number; label: string };
  labelOf: (x: number) => string;
}) {
  const { isStatic } = useDeck();
  const reduce = useReducedMotion();
  const animate = !isStatic && !reduce;
  const { ref, inView } = useInView<HTMLDivElement>(0.2);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 360 });
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setSize({
        w: Math.max(320, entry.contentRect.width),
        h: Math.max(220, entry.contentRect.height),
      }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const narrow = size.w < 640 * SCALE;
  const pad = { l: 44 * SCALE, r: (narrow ? 92 : 190) * SCALE, t: 18 * SCALE, b: 34 * SCALE };
  const X = (v: number) => pad.l + ((v - x.min) / (x.max - x.min)) * (size.w - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - v / y.max) * (size.h - pad.t - pad.b);
  const path = (pts: [number, number][]) =>
    pts.map(([a, b], i) => `${i ? 'L' : 'M'}${X(a).toFixed(1)},${Y(b).toFixed(1)}`).join(' ');
  const xs = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p[0])))).sort(
    (a, b) => a - b,
  );
  const valueAt = (s: Series, at: number) => s.points.find((p) => p[0] === at)?.[1];
  const fmt = (v: number) =>
    unit === '%' ? `${v % 1 ? v.toFixed(1) : v}%` : v.toLocaleString() + unit;

  function move(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    let best = xs[0];
    for (const v of xs) if (Math.abs(X(v) - px) < Math.abs(X(best) - px)) best = v;
    setHover(best);
  }

  const hx = hover === null ? 0 : X(hover);
  const top = series[0];
  return (
    <div className="rl" ref={ref}>
      <div className="rl-box" ref={box}>
        <svg
          width={size.w}
          height={size.h}
          onPointerMove={move}
          onPointerDown={move}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={`Line chart: ${series.map((s) => s.name).join(', ')}`}
        >
          {y.ticks.map((t) => (
            <g key={t}>
              <line
                className={t === 0 ? 'rl-axis' : 'rl-grid'}
                x1={pad.l}
                x2={size.w - pad.r}
                y1={Y(t)}
                y2={Y(t)}
              />
              <text
                className="rl-tick"
                x={pad.l - 10 * SCALE}
                y={Y(t) + 4 * SCALE}
                textAnchor="end"
              >
                {fmt(t)}
              </text>
            </g>
          ))}
          {x.ticks.map((t) => (
            <text
              key={t.label}
              className="rl-tick"
              x={X(t.at)}
              y={size.h - 10 * SCALE}
              textAnchor="middle"
            >
              {t.label}
            </text>
          ))}
          {marker && (
            <g>
              <line
                className="rl-marker"
                x1={X(marker.at)}
                x2={X(marker.at)}
                y1={pad.t}
                y2={size.h - pad.b}
              />
              <text className="rl-note" x={X(marker.at) + 8 * SCALE} y={pad.t + 12 * SCALE}>
                {marker.label}
              </text>
            </g>
          )}
          {reference && (
            <g>
              <line
                className="rl-marker"
                x1={pad.l}
                x2={size.w - pad.r}
                y1={Y(reference.at)}
                y2={Y(reference.at)}
              />
              <text
                className="rl-note"
                x={size.w - pad.r + 10 * SCALE}
                y={Y(reference.at) + 4 * SCALE}
              >
                {reference.label}
              </text>
            </g>
          )}
          {series.map((s) => (
            <motion.path
              key={s.name}
              className={`rl-line ${s.tone}`}
              d={path(s.points)}
              initial={animate ? { pathLength: 0 } : false}
              animate={{ pathLength: inView ? 1 : 0 }}
              transition={{ duration: 1.4, ease: [0.16, 1, 0.3, 1] }}
            />
          ))}
          {series.map((s) => {
            const [lx, ly] = s.points[s.points.length - 1];
            return (
              <motion.g
                key={s.name}
                initial={animate ? { opacity: 0 } : false}
                animate={{ opacity: inView ? 1 : 0 }}
                transition={{ delay: 1.1 }}
              >
                <circle className={`rl-dot ${s.tone}`} cx={X(lx)} cy={Y(ly)} r={5 * SCALE} />
                <text className={`rl-end ${s.tone}`} x={X(lx) + 12 * SCALE} y={Y(ly) - 2 * SCALE}>
                  {fmt(ly)}
                </text>
                {!narrow && (
                  <text className="rl-end-label" x={X(lx) + 12 * SCALE} y={Y(ly) + 16 * SCALE}>
                    {s.label ?? s.name}
                  </text>
                )}
              </motion.g>
            );
          })}
          {hover !== null && (
            <g className="rl-hover">
              <line x1={hx} x2={hx} y1={pad.t} y2={size.h - pad.b} />
              {series.map((s) => {
                const v = valueAt(s, hover);
                return v === undefined ? null : (
                  <circle
                    key={s.name}
                    className={`rl-dot ${s.tone}`}
                    cx={hx}
                    cy={Y(v)}
                    r={6 * SCALE}
                  />
                );
              })}
            </g>
          )}
        </svg>
        {hover !== null && (
          <div
            className={`rl-tip${hx > size.w * 0.6 ? ' flip' : ''}`}
            style={{ left: hx, top: Y(valueAt(top, hover) ?? valueAt(series[1], hover) ?? 0) }}
          >
            <strong>{labelOf(hover)}</strong>
            {series.map((s) => {
              const v = valueAt(s, hover);
              return v === undefined ? null : (
                <span key={s.name} className={s.tone}>
                  {s.name}
                  <b>{fmt(v)}</b>
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
