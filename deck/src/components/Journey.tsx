import { Fragment } from 'react';
import Build from '../deck/Build';
import Reveal from '../deck/Reveal';
import './honey.css';

/* Two rows of steps: how acting on an idea works today, then (on click) with Honey. */
const Row = ({ steps, tone }: { steps: string[]; tone: 'today' | 'honey' }) => (
  <ol className={`jy-steps ${tone}`}>
    {steps.map((s, i) => (
      <Fragment key={s}>
        {i > 0 && (
          <li className="jy-arrow" aria-hidden>
            →
          </li>
        )}
        <li className="jy-step">
          <span className="jy-n">{i + 1}</span>
          {s}
        </li>
      </Fragment>
    ))}
  </ol>
);

export default function Journey({ today, honey }: { today: string[]; honey: string[] }) {
  return (
    <div className="jy">
      <Reveal className="jy-row">
        <div className="jy-label">
          Today <b>{today.length} steps</b>
        </div>
        <Row steps={today} tone="today" />
      </Reveal>
      <Build at={1} className="jy-row">
        <div className="jy-label honey">
          With Honey <b>{honey.length} steps</b>
        </div>
        <Row steps={honey} tone="honey" />
      </Build>
    </div>
  );
}
