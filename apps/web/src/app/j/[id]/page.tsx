import type { Metadata } from 'next';
import { PostHead, StrategyWell } from '@/components/site/share-card';
import { Missing, SharePage } from '@/components/site/share-page';
import { jarMetadata, loadJar, loadLogos } from '@/lib/share';

type Props = { params: Promise<{ id: string }> };

// export const revalidate = REVALIDATE;
// Next needs a literal here (segment config is read at build time); keep in step with REVALIDATE.
export const revalidate = 300;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return jarMetadata(await loadJar(id), id);
}

/**
 * A shared jar (honeywallet.org/j/<id>): its card as the Feed shows it, and "Buy this
 * jar", which opens it in Honey (its Copy buys it) or sends a phone to its store. With
 * Honey installed the link itself opens the app (public/.well-known claims /j/*).
 */
export default async function JarPage({ params }: Props) {
  const { id } = await params;
  const [jar, logos] = await Promise.all([loadJar(id), loadLogos()]);
  if (!jar) return <Missing what="jar" />;
  return (
    <SharePage bare openIn={`jar/social-${jar.id}`} action="Buy this jar">
      <PostHead who={jar.owner} words={jar.thesis || undefined} />
      <StrategyWell
        name={jar.name}
        tokens={jar.picks}
        move={jar.returnsHidden ? null : jar.returnSincePublish}
        hidden={jar.holdingsHidden || jar.picks.length === 0}
        note={jar.copies > 0 ? `${jar.copies} ${jar.copies === 1 ? 'copy' : 'copies'}` : undefined}
        logos={logos}
      />
      {jar.returnsHidden ? null : (
        <p className="text-muted-foreground text-sm">Return since it was published.</p>
      )}
    </SharePage>
  );
}
