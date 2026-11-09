import { motion, useReducedMotion } from 'framer-motion';
import { useDeck } from '../deck/DeckContext';
import './tryit.css';

/* Try it: the four commands in a compact terminal, beside three real app screens (full width, never cropped
   at the sides), each with a number and a word or two. Flat hairline cards; things rise in left to right. */
type Step = { action: string; shot: string };

const EASE = [0.16, 1, 0.3, 1] as const;

export default function TryIt({ commands, steps }: { commands: string[]; steps: Step[] }) {
  const { isStatic } = useDeck();
  const reduce = useReducedMotion();
  const animate = !isStatic && !reduce;
  const rise = (i: number) => ({
    initial: animate ? { opacity: 0, y: 18 } : false,
    animate: { opacity: 1, y: 0 },
    transition: { delay: animate ? 0.2 + i * 0.12 : 0, duration: 0.55, ease: EASE },
  });

  return (
    <div className="ti">
      <motion.div className="ti-term" {...rise(0)}>
        <div className="ti-bar">
          <i />
          <i />
          <i />
          <span>Terminal</span>
        </div>
        <pre>
          {commands.map((c) => (
            <code key={c}>
              <span className="ti-ps">$</span>
              {c.split(' ').map((w, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: words of a fixed command, never reordered
                <span key={i} className="ti-w">
                  {i ? ' ' : ''}
                  {w}
                </span>
              ))}
            </code>
          ))}
        </pre>
      </motion.div>

      <ol className="ti-steps">
        {steps.map((s, i) => (
          <motion.li key={s.action} className="ti-step" {...rise(i + 1)}>
            <img
              className="ti-shot"
              src={s.shot}
              alt={`Honey app: ${s.action}`}
              draggable={false}
            />
            <div className="ti-cap">
              <span className="ti-n">{i + 1}</span>
              {s.action}
            </div>
          </motion.li>
        ))}
      </ol>
    </div>
  );
}
