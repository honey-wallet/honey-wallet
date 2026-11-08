import type { CSSProperties, ReactNode } from 'react';
import Reveal from '../deck/Reveal';
import './compare.css';

/* A paper comparison table: a label column, then one column per product.
   The `hero` column is tinted in the accent colour from header to last row.
   Rows rise in one after another. */
export type Col = { name: string; sub?: string; hero?: boolean };
export type Row = { label: string; icon?: ReactNode; cells: ReactNode[] };

export default function Compare({ cols, rows }: { cols: Col[]; rows: Row[] }) {
  const style = { '--vs-cols': cols.length } as CSSProperties;
  const cls = (base: string, j: number) => `${base}${cols[j].hero ? ' hero' : ''}`;
  return (
    <div className="vs" style={style}>
      <Reveal className="vs-row vs-head">
        <div className="vs-label" />
        {cols.map((c, j) => (
          <div key={c.name} className={cls('vs-cell', j)}>
            <b>{c.name}</b>
            {c.sub && <span>{c.sub}</span>}
          </div>
        ))}
      </Reveal>
      {rows.map((r, i) => (
        <Reveal key={r.label} delay={0.1 + i * 0.08} className="vs-row">
          <div className="vs-label">
            {r.icon && <span className="vs-icon">{r.icon}</span>}
            {r.label}
          </div>
          {r.cells.map((cell, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed slide content, never reordered
            <div key={j} className={cls('vs-cell', j)}>
              {cell}
            </div>
          ))}
        </Reveal>
      ))}
    </div>
  );
}
