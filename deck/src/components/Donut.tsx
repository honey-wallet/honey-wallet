/* A small donut chart in a 100×100 box: parts are drawn clockwise from 12 o'clock. */
export default function Donut({
  parts,
  gap = 1.6,
}: {
  parts: { value: number; color: string }[];
  gap?: number;
}) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const r = 38;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg className="donut" viewBox="0 0 100 100" aria-hidden>
      {parts.map((p, i) => {
        const len = (p.value / total) * c;
        const el = (
          <circle
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed slide content, never reordered
            key={i}
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke={p.color}
            strokeWidth="16"
            strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 50 50)"
          />
        );
        offset += len;
        return el;
      })}
    </svg>
  );
}
