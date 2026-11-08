import type { ReactNode } from 'react';
import Reveal from '../deck/Reveal';
import Donut from './Donut';
import Logo, { Brand, logoFor } from './Logo';
import './honey.css';

/* Jars in three app moments, drawn as small cards: write an idea, review the proposal, buy. */
type Pick = { symbol: string; weight: number; color: string };

const Card = ({
  n,
  title,
  body,
  children,
  delay,
}: {
  n: number;
  title: string;
  body: ReactNode;
  children: ReactNode;
  delay: number;
}) => (
  <Reveal delay={delay} className="jf-col">
    <div className="jf-card">{children}</div>
    <div className="jf-caption">
      <span className="jf-n">{n}</span>
      <div>
        <b>{title}</b>
        <span>{body}</span>
      </div>
    </div>
  </Reveal>
);

export default function JarFlow({
  idea,
  picks,
  amount,
}: {
  idea: string;
  picks: Pick[];
  amount: number;
}) {
  return (
    <div className="jf">
      <Card n={1} delay={0} title="Write an idea" body="In your words, with links if you like.">
        <div className="jf-prompt">What do you believe in? Ask Honey</div>
        <div className="jf-input">
          <span>{idea}</span>
          <i className="jf-send" aria-hidden>
            ↑
          </i>
        </div>
        <div className="jf-chips">
          <span>$ {amount}</span>
          <span>Medium risk</span>
        </div>
      </Card>
      <Card
        n={2}
        delay={0.12}
        title="Review the proposal"
        body="Picks, weights, fees, sources and a critic’s warning. Edit anything."
      >
        <div className="jf-pie">
          <Donut parts={picks.map((p) => ({ value: p.weight, color: p.color }))} />
          <ul>
            {picks.map((p) => (
              <li key={p.symbol}>
                {logoFor(p.symbol) ? (
                  <span className="jf-ring" style={{ boxShadow: `0 0 0 2px ${p.color}` }}>
                    <Logo id={logoFor(p.symbol)!} size="26px" />
                  </span>
                ) : (
                  <i style={{ background: p.color }} />
                )}
                {p.symbol}
                <b>{p.weight}%</b>
              </li>
            ))}
          </ul>
        </div>
      </Card>
      <Card
        n={3}
        delay={0.24}
        title="Buy in one approval"
        body={
          <>
            <Brand id="near">NEAR Intents</Brand> fills every pick, on every chain.
          </>
        }
      >
        <dl className="jf-summary">
          <div>
            <dt>Visibility</dt>
            <dd>Public</dd>
          </div>
          <div>
            <dt>Max slippage</dt>
            <dd>1%</dd>
          </div>
          <div>
            <dt>Order</dt>
            <dd>Market</dd>
          </div>
        </dl>
        <div className="jf-buy">Buy ${amount} and launch</div>
      </Card>
    </div>
  );
}
