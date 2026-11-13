import type { Metadata } from 'next';
import { Change, Initial, type Jar, Missing, read, SharePage } from '@/components/site/share-page';

type Props = { params: Promise<{ id: string }> };

const load = async (id: string) =>
  /^[0-9a-f-]{36}$/i.test(id) ? read<Jar>(`/social/jars/${id}`) : null;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const jar = await load((await params).id);
  if (!jar) return { title: 'Jar · Honey' };
  return { title: `${jar.name} by @${jar.owner.handle} · Honey`, description: jar.thesis };
}

/** A shared public jar: its idea, its tokens and weights, and how it has done. */
export default async function JarPage({ params }: Props) {
  const jar = await load((await params).id);
  if (!jar) return <Missing what="jar" />;
  return (
    <SharePage openIn={`u/${jar.owner.handle}`}>
      <div className="flex items-center gap-3">
        <Initial name={jar.owner.displayName} />
        <div className="flex flex-col">
          <span className="font-semibold">{jar.name}</span>
          <span className="text-muted-foreground text-sm">by @{jar.owner.handle}</span>
        </div>
        <span className="ml-auto text-xl font-semibold">
          <Change value={jar.returnSincePublish} />
        </span>
      </div>
      {jar.thesis ? <p className="text-lg leading-relaxed">{jar.thesis}</p> : null}
      <ul className="flex flex-col gap-1">
        {jar.picks.map((p) => (
          <li key={p.symbol} className="flex justify-between tabular-nums">
            <span className="font-medium">{p.symbol}</span>
            <span className="text-muted-foreground">{p.weight}%</span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-sm">
        {jar.copies} {jar.copies === 1 ? 'copy' : 'copies'} · return since it was published
      </p>
    </SharePage>
  );
}
