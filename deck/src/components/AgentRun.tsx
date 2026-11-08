import { motion, useReducedMotion } from 'framer-motion';
import { useDeck } from '../deck/DeckContext';
import Reveal from '../deck/Reveal';
import Logo, { Brand, logoFor } from './Logo';
import './honey.css';

/* The agent at work: its real progress steps tick off one by one, then the proposal lands. */
type Pick = {
  symbol: string;
  name: string;
  chain: string;
  weight: number;
  reason: string;
  color: string;
};

const STEP = 0.55;

export default function AgentRun({
  stages,
  thesis,
  picks,
  caution,
  fee,
}: {
  stages: string[];
  thesis: string;
  picks: Pick[];
  caution: string;
  fee: string;
}) {
  const { isStatic } = useDeck();
  const reduce = useReducedMotion();
  const animate = !isStatic && !reduce;
  const done = stages.length * STEP;
  return (
    <div className="ag">
      <Reveal className="ag-stages">
        <div className="ag-head">
          <Brand id="near" size="1.6em">
            NEAR AI Cloud
          </Brand>
        </div>
        <ol>
          {stages.map((s, i) => (
            <li key={s}>
              <motion.span
                className="ag-tick"
                aria-hidden
                initial={
                  animate
                    ? { backgroundColor: 'rgba(246,243,235,0.09)', color: 'rgba(0,0,0,0)' }
                    : false
                }
                animate={{ backgroundColor: '#f3c969', color: '#131313' }}
                transition={{ delay: animate ? 0.3 + (i + 1) * STEP : 0, duration: 0.25 }}
              >
                ✓
              </motion.span>
              <motion.span
                initial={animate ? { opacity: 0.35 } : false}
                animate={{ opacity: 1 }}
                transition={{ delay: animate ? 0.3 + i * STEP : 0, duration: 0.3 }}
              >
                {s}
              </motion.span>
            </li>
          ))}
        </ol>
      </Reveal>
      <motion.div
        className="ag-card"
        initial={animate ? { opacity: 0, y: 24, scale: 0.98 } : false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ delay: animate ? 0.5 + done : 0, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="ag-kicker">Proposal</div>
        <div className="ag-thesis">{thesis}</div>
        <ul className="ag-picks">
          {picks.map((p) => (
            <li key={p.symbol}>
              {logoFor(p.symbol) ? (
                <Logo id={logoFor(p.symbol)!} size="40px" />
              ) : (
                <i style={{ background: p.color }}>{p.symbol.slice(0, 1)}</i>
              )}
              <div className="ag-name">
                <b>{p.symbol}</b>{' '}
                <span className="ag-chain">
                  {logoFor(p.chain) && <Logo id={logoFor(p.chain)!} size="14px" />}
                  {p.chain}
                </span>
                <small>{p.reason}</small>
              </div>
              <div className="ag-weight">
                <b>{p.weight}%</b>
                <span>
                  <em style={{ width: `${p.weight * 2}%`, background: p.color }} />
                </span>
              </div>
            </li>
          ))}
        </ul>
        <div className="ag-critic">
          <b>Critic</b> {caution}
        </div>
        <div className="ag-foot">
          <span>Fees {fee}</span>
          <span>Sources linked</span>
          <span>Sample prices (test mode)</span>
        </div>
      </motion.div>
    </div>
  );
}
