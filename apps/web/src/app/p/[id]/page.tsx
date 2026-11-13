import type { Metadata } from 'next';
import {
  Change,
  Initial,
  Missing,
  type Post,
  price,
  read,
  SharePage,
} from '@/components/site/share-page';

type Props = { params: Promise<{ id: string }> };

const load = async (id: string) =>
  /^[0-9a-f-]{36}$/i.test(id) ? read<Post>(`/social/posts/${id}`) : null;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = await load((await params).id);
  if (!post) return { title: 'Thesis · Honey' };
  const tokens = post.tokens.map((t) => `$${t.symbol}`).join(' ');
  return {
    title: `@${post.author.handle}'s thesis on ${tokens} · Honey`,
    description: post.body.slice(0, 200),
  };
}

/** A shared thesis: who, which tokens at what price then and how they've done since. */
export default async function PostPage({ params }: Props) {
  const post = await load((await params).id);
  if (!post) return <Missing what="thesis" />;
  return (
    <SharePage openIn={`u/${post.author.handle}`}>
      <div className="flex items-center gap-3">
        <Initial name={post.author.displayName} />
        <div className="flex flex-col">
          <span className="font-semibold">@{post.author.handle}</span>
          <span className="text-muted-foreground text-sm">Thesis</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {post.tokens.map((t) => (
          <span key={t.symbol} className="tabular-nums">
            <strong>{t.symbol}</strong> {price(t.priceAtPost)} (<Change value={t.change} />)
          </span>
        ))}
      </div>
      <p className="whitespace-pre-wrap text-lg leading-relaxed">{post.body}</p>
      <p className="text-muted-foreground text-sm">
        Prices are when it was posted, then the move since.
      </p>
    </SharePage>
  );
}
