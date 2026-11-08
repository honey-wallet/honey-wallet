import type { ReactNode } from 'react';
import Reveal from '../deck/Reveal';
import './research.css';

/* A data slide that uses the whole screen: kicker + headline on top, the
   visual filling every remaining pixel, and a one-line source at the foot.
   Optional `aside` stats sit in a narrow column beside the visual. */
export default function ChartSlide({
  title,
  children,
  aside,
  source,
}: {
  kicker?: string;
  title: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
  source: ReactNode;
  nav?: string;
  notes?: string;
}) {
  return (
    <div className="slide full">
      <div className="cs">
        <Reveal className="cs-head">
          <h2 className="headline cs-title">{title}</h2>
        </Reveal>
        <div className={`cs-body${aside ? ' with-aside' : ''}`}>
          <div className="cs-visual">{children}</div>
          {aside && <div className="cs-aside">{aside}</div>}
        </div>
        <p className="foot cs-source">{source}</p>
      </div>
    </div>
  );
}

/* A compact stat for the aside column: big figure, short label. */
export function AsideStat({ value, label }: { value: string; label: ReactNode }) {
  return (
    <div className="as">
      <div className="as-value">{value}</div>
      <div className="as-label">{label}</div>
    </div>
  );
}

/* Giant figures across the slide: <BigStats items={[{ value, label, source }]} /> */
export function BigStats({
  items,
}: {
  items: { value: ReactNode; label: ReactNode; source?: ReactNode; brand?: ReactNode }[];
}) {
  return (
    <div className="bs">
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed slide content, never reordered
        <Reveal key={i} delay={i * 0.08} className="bs-item">
          {item.brand && <div className="bs-brand">{item.brand}</div>}
          <div className="bs-value">{item.value}</div>
          <div className="bs-label">{item.label}</div>
          {item.source && <div className="bs-source">{item.source}</div>}
        </Reveal>
      ))}
    </div>
  );
}
