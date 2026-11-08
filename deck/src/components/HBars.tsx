import { motion, useReducedMotion } from 'framer-motion';
import { useDeck } from '../deck/DeckContext';
import { useInView } from '../deck/useInView';
import './research.css';

/* Full-width horizontal bars on a 0–100% track, value at the end of each bar.
   Rows highlight on hover and carry their detail (period, sample) as a title.
   <HBars rows={[{ label: 'LinkedIn', value: 75.6, detail: 'Jul 2026, 123 posts' }]} /> */
export default function HBars({
  rows,
  muteBelow = 50,
}: {
  rows: { label: string; value: number; detail?: string }[];
  muteBelow?: number;
}) {
  const { isStatic } = useDeck();
  const reduce = useReducedMotion();
  const animate = !isStatic && !reduce;
  const { ref, inView } = useInView<HTMLDivElement>(0.2);
  return (
    <div className="hb" ref={ref}>
      {rows.map((r, i) => (
        <div
          className="hb-row"
          key={r.label}
          title={r.detail ? `${r.label}: ${r.value}%. ${r.detail}` : undefined}
        >
          <span className="hb-label">{r.label}</span>
          <span className="hb-track">
            <motion.span
              className={`hb-bar${r.value < muteBelow ? ' muted' : ''}`}
              initial={animate ? { width: 0 } : false}
              animate={{ width: inView ? `${r.value}%` : 0 }}
              transition={{ duration: 0.9, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] }}
            />
          </span>
          <span className="hb-value">{Math.round(r.value)}%</span>
        </div>
      ))}
    </div>
  );
}
