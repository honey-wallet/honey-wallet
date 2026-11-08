import { Fragment, type ReactNode } from 'react';
import './research.css';

/* A four-step process, drawn like a figure in a paper: four boxes and arrows, with
   the on-device steps inside a dashed frame. Each box has a small line drawing
   in one stroke weight; the accent colour marks the thing the step produces. */

type Step = { title: string; body: ReactNode; figure?: ReactNode };

const Box = ({ step, col }: { step: Step; col: number }) => (
  // biome-ignore lint/a11y/useSemanticElements: an item of the grid list in ProcessFlow
  <div className="pf-step" role="listitem" style={{ gridColumn: col }}>
    {step.figure && (
      <svg className="pf-fig" viewBox="0 0 160 90" aria-hidden>
        {step.figure}
      </svg>
    )}
    <b>{step.title}</b>
    <span>{step.body}</span>
  </div>
);
const Arrow = ({ col }: { col: number }) => (
  <span className="pf-arrow" aria-hidden style={{ gridColumn: col }}>
    →
  </span>
);

/* A page of text, a picture and a sound wave: anything you make. */
export const CreateFigure = (
  <>
    <rect x="18" y="8" width="62" height="74" />
    <path d="M28 22h42M28 32h42M28 42h30" />
    <rect x="92" y="8" width="50" height="34" />
    <path d="M92 36l14-12 10 8 8-6 18 14" />
    <circle cx="104" cy="18" r="3" />
    <path d="M92 64h6M102 56v16M108 50v28M114 58v12M120 52v24M126 60v8M132 56v16M138 64h4" />
  </>
);

/* Each action is a link in a chain; every link is signed. */
export const SignFigure = (
  <>
    {[0, 1, 2, 3].map((i) => (
      <g key={i} transform={`translate(${10 + i * 38} 18)`}>
        <rect width="26" height="26" />
        <path className="pf-accent" d="M7 13.5l4.5 4.5L19 9" />
        {i < 3 && <path d="M26 13h12" />}
      </g>
    ))}
    <circle cx="70" cy="70" r="7" />
    <path d="M77 70h22M91 70v6M97 70v6" />
  </>
);

/* A proof file leaving the device: a document with a check, and an arrow out. */
export const ShareFigure = (
  <>
    <path d="M40 10h34l14 14v56H40z" />
    <path d="M74 10v14h14" />
    <path className="pf-accent" d="M55 50l8 8 16-18" />
    <path d="M104 46h40" />
    <path d="M134 36l10 10-10 10" />
  </>
);

/* A browser window that says yes. */
export const VerifyFigure = (
  <>
    <rect x="16" y="8" width="128" height="74" />
    <path d="M16 22h128" />
    <circle cx="25" cy="15" r="1.5" />
    <circle cx="32" cy="15" r="1.5" />
    <circle cx="39" cy="15" r="1.5" />
    <circle className="pf-accent" cx="80" cy="52" r="16" />
    <path className="pf-accent" d="M72 52l6 6 11-12" />
  </>
);

export default function Process({
  steps,
  privateLabel,
  sharedLabel,
}: {
  steps: [Step, Step, Step, Step];
  privateLabel: ReactNode;
  sharedLabel: ReactNode;
}) {
  return (
    <div className="pf-wrap">
      {/* biome-ignore lint/a11y/useSemanticElements: a CSS grid that also holds the frame and labels, which a <ul> could not contain */}
      <div className="pf" role="list">
        <div className="pf-frame" aria-hidden />
        <p className="pf-label private">{privateLabel}</p>
        <p className="pf-label shared">{sharedLabel}</p>
        {steps.map((step, i) => (
          <Fragment key={step.title}>
            {i > 0 && <Arrow col={i * 2} />}
            <Box step={step} col={i * 2 + 1} />
          </Fragment>
        ))}
      </div>
    </div>
  );
}
