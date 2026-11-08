import type { ReactNode } from 'react';
import Reveal from '../deck/Reveal';
import './honey.css';

/* Two lists side by side: what existed before the hackathon, and what was built in it. */
export default function Ledger({
  before,
  built,
  note,
}: {
  before: { title: string; items: ReactNode[] };
  built: { title: string; items: ReactNode[] };
  note: ReactNode;
}) {
  return (
    <div className="lg">
      <Reveal className="lg-col">
        <div className="lg-head">{before.title}</div>
        <ul>
          {before.items.map((x, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed slide content, never reordered
            <li key={i}>{x}</li>
          ))}
        </ul>
      </Reveal>
      <Reveal delay={0.12} className="lg-col built">
        <div className="lg-head">{built.title}</div>
        <ul>
          {built.items.map((x, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed slide content, never reordered
            <li key={i}>{x}</li>
          ))}
        </ul>
      </Reveal>
      <Reveal delay={0.24} className="lg-note">
        {note}
      </Reveal>
    </div>
  );
}
