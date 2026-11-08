import type { ReactNode } from 'react';
import Build from '../deck/Build';
import Reveal from '../deck/Reveal';
import './showdown.css';

/* Two screenshots of the same text, side by side, in paper frames. The left
   one shows first; the right one arrives on the next click with a verdict
   stamped over it. <Showdown left={{ src, label }} right={{ src, label, stamp }} /> */
export type Pane = { src: string; alt: string; label: ReactNode; stamp?: string };

export default function Showdown({ left, right }: { left: Pane; right: Pane }) {
  return (
    <div className="sd">
      <Reveal className="sd-pane sd-wide">
        <figure className="sd-frame">
          <img src={left.src} alt={left.alt} />
          {left.stamp && <span className="sd-stamp">{left.stamp}</span>}
        </figure>
        <figcaption className="sd-label">{left.label}</figcaption>
      </Reveal>
      <Build at={1} className="sd-pane sd-tall">
        <figure className="sd-frame">
          <img src={right.src} alt={right.alt} />
          {right.stamp && <span className="sd-stamp">{right.stamp}</span>}
        </figure>
        <figcaption className="sd-label">{right.label}</figcaption>
      </Build>
    </div>
  );
}
