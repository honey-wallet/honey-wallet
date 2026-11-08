import { sources } from '../data/sources';

/* A numbered citation that links to the source: {cite(3)} renders [3]. */
export const cite = (n: number) => {
  const s = sources.find((x) => x.n === n);
  if (!s) throw new Error(`cite(${n}): no source ${n} in src/data/sources.ts`);
  return (
    <a className="cite" href={s.url} target="_blank" rel="noopener" title={s.label}>
      [{n}]
    </a>
  );
};

/* Fractional year from an ISO date, for time-series x values: year('2022-11-30'). */
export const year = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return y + (m - 1) / 12 + (d - 1) / 365;
};
