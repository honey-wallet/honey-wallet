/* Line drawings for the safety figure (Process), in a 160×90 box. pf-accent marks the honey part. */

/* A page wrapped in tags: the agent reads it as quoted material, not orders. */
export const ReadFigure = (
  <>
    <rect x="30" y="12" width="100" height="66" rx="8" />
    <path d="M42 30h52M42 42h76M42 54h60" />
    <path className="pf-accent" d="M20 30L8 45l12 15M140 30l12 15-12 15" />
  </>
);

/* An answer checked against a schema: rows with ticks. */
export const CheckFigure = (
  <>
    <rect x="34" y="10" width="92" height="70" rx="8" />
    {[26, 44, 62].map((y) => (
      <g key={y}>
        <path d={`M48 ${y}h44`} />
        <path className="pf-accent" d={`M102 ${y}l4 4 8-8`} />
      </g>
    ))}
  </>
);

/* A phone with the one approval button. */
export const ApproveFigure = (
  <>
    <rect x="56" y="4" width="48" height="82" rx="10" />
    <path d="M66 22h28M66 32h20M66 42h24" />
    <rect className="pf-accent" x="64" y="62" width="32" height="12" rx="6" />
  </>
);

/* One order fanning out to several chains. */
export const SettleFigure = (
  <>
    <circle className="pf-accent" cx="30" cy="45" r="12" />
    <path d="M42 45h20M62 45L118 18M62 45h56M62 45l56 27" />
    <circle cx="130" cy="18" r="9" />
    <circle cx="130" cy="45" r="9" />
    <circle cx="130" cy="72" r="9" />
  </>
);
