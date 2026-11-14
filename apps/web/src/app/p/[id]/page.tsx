import type { Metadata } from 'next';
import { PostHead, StrategyWell } from '@/components/site/share-card';
import { Missing, price, SharePage } from '@/components/site/share-page';
import { equalWeights, loadLogos, loadThesis, thesisMetadata, thesisMove } from '@/lib/share';

type Props = { params: Promise<{ id: string }> };

// export const revalidate = REVALIDATE;
// Next needs a literal here (segment config is read at build time); keep in step with REVALIDATE.
export const revalidate = 300;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return thesisMetadata(await loadThesis(id), id);
}

/**
 * A shared thesis (honeywallet.org/p/<id>): the words and its tokens in equal parts, as
 * the Feed shows it, with each token's price when it was posted. "Buy these tokens"
 * opens it in Honey (its jar, if it's about one).
 */
export default async function PostPage({ params }: Props) {
  const { id } = await params;
  const [post, logos] = await Promise.all([loadThesis(id), loadLogos()]);
  if (!post) return <Missing what="thesis" />;
  const weights = equalWeights(post.tokens.length);
  const only = post.tokens.length === 1 ? post.tokens[0] : undefined;
  return (
    <SharePage
      bare
      openIn={post.jarId ? `jar/social-${post.jarId}` : `jar/post-${post.id}`}
      action={post.jarId ? 'Buy this jar' : only ? `Buy ${only.symbol}` : 'Buy these tokens'}
    >
      <PostHead who={post.author} words={post.body} />
      <StrategyWell
        name={only ? only.symbol : 'Equal parts'}
        tokens={post.tokens.map((t, i) => ({ symbol: t.symbol, weight: weights[i] ?? 0 }))}
        move={thesisMove(post)}
        hidden={post.tokens.length === 0}
        logos={logos}
      />
      <p className="text-muted-foreground text-sm tabular-nums">
        {post.tokens.map((t) => `${t.symbol} ${price(t.priceAtPost)}`).join(' · ')} when posted,
        then the move since.
      </p>
    </SharePage>
  );
}
