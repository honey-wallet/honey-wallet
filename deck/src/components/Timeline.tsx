import type { ReactNode } from 'react';
import Reveal from '../deck/Reveal';
import './honey.css';

/* The hackathon on one line: dated marks, what existed before (grey) and what was built in the window (honey). */
type Mark = { at: number; date: string; label: string; honey?: boolean };

export default function Timeline({
  marks,
  before,
  built,
  from,
  to,
}: {
  marks: Mark[];
  before: ReactNode[];
  built: ReactNode[];
  from: number;
  to: number;
}) {
  const pos = (d: number) => `${((d - from) / (to - from)) * 100}%`;
  const window0 = marks.find((m) => m.honey)?.at ?? from;
  return (
    <div className="hx">
      <div className="hx-lanes">
        <Reveal className="hx-lane" style={{ left: 0, width: pos(window0) }}>
          {before.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed slide content, never reordered
            <span key={i} className="hx-chip">
              {b}
            </span>
          ))}
        </Reveal>
        <Reveal delay={0.15} className="hx-lane built" style={{ left: pos(window0), right: 0 }}>
          {built.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed slide content, never reordered
            <span key={i} className="hx-chip honey">
              {b}
            </span>
          ))}
        </Reveal>
      </div>
      <div className="hx-axis">
        <div className="hx-window" style={{ left: pos(window0), right: 0 }} />
        {marks.map((m) => (
          <div
            key={m.date}
            className={`hx-mark${m.honey ? ' honey' : ''}${m.at === from ? ' start' : ''}${m.at === to ? ' end' : ''}`}
            style={{ left: pos(m.at) }}
          >
            <i />
            <b>{m.date}</b>
            <span>{m.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
