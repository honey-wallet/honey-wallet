import type { ReactNode } from 'react';
import Reveal from '../deck/Reveal';
import './audience.css';

/* Who needs this: a grid of plain boxes, one per kind of writer, each with a
   one-line reason. The last box is a sourced figure in the accent colour.
   <Audience people={[{ who: 'Authors', why: '…' }]} stat={{ value: '61%', label: '…' }} /> */
export type Who = { who: string; why: ReactNode };

export default function Audience({
  people,
  stat,
}: {
  people: Who[];
  stat?: { value: ReactNode; label: ReactNode };
}) {
  return (
    <div className="au">
      {people.map((p, i) => (
        <Reveal key={p.who} delay={i * 0.06} className="au-item">
          <b>{p.who}</b>
          <span>{p.why}</span>
        </Reveal>
      ))}
      {stat && (
        <Reveal delay={people.length * 0.06} className="au-item au-stat">
          <div className="au-value">{stat.value}</div>
          <span>{stat.label}</span>
        </Reveal>
      )}
    </div>
  );
}
