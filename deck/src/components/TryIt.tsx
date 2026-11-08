import Reveal from '../deck/Reveal';
import './honey.css';

/* A terminal with the commands, beside the numbered things to try. */
export default function TryIt({
  commands,
  steps,
}: {
  commands: string[];
  steps: { action: string; see?: string }[];
}) {
  return (
    <div className="ti">
      <Reveal className="ti-term">
        <div className="ti-bar">
          <i />
          <i />
          <i />
          <span>Terminal</span>
        </div>
        <pre>
          {commands.map((c) => (
            <code key={c}>
              <span className="ti-ps">$</span> {c}
              {'\n'}
            </code>
          ))}
        </pre>
      </Reveal>
      <ol className="ti-steps">
        {steps.map((s, i) => (
          <Reveal key={s.action} delay={0.1 + i * 0.07} className="ti-step">
            <span className="ti-n">{i + 1}</span>
            <div>
              <b>{s.action}</b>
              {s.see && <span>{s.see}</span>}
            </div>
          </Reveal>
        ))}
      </ol>
    </div>
  );
}
