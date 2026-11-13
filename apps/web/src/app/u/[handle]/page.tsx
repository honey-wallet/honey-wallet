import type { Metadata } from 'next';
import {
  Change,
  Initial,
  Missing,
  type Profile,
  read,
  SharePage,
} from '@/components/site/share-page';

type Props = { params: Promise<{ handle: string }> };

const load = async (raw: string) => {
  const handle = decodeURIComponent(raw).replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{3,20}$/.test(handle) ? read<Profile>(`/social/profiles/${handle}`) : null;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const profile = await load((await params).handle);
  if (!profile) return { title: 'Profile · Honey' };
  return {
    title: `${profile.displayName} (@${profile.handle}) · Honey`,
    description: profile.bio || `Follow @${profile.handle} on Honey.`,
  };
}

/** A shared profile: who, their latest theses and public jars. */
export default async function ProfilePage({ params }: Props) {
  const profile = await load((await params).handle);
  if (!profile) return <Missing what="profile" />;
  return (
    <SharePage openIn={`u/${profile.handle}`}>
      <div className="flex items-center gap-3">
        <Initial name={profile.displayName} />
        <div className="flex flex-col">
          <span className="font-semibold">{profile.displayName}</span>
          <span className="text-muted-foreground text-sm">@{profile.handle}</span>
        </div>
      </div>
      {profile.bio ? <p>{profile.bio}</p> : null}
      <p className="text-muted-foreground text-sm tabular-nums">
        {profile.followers} followers · {profile.following} following · {profile.jars.length} public
        jars
      </p>
      {profile.posts.slice(0, 3).map((post) => (
        <div key={post.id} className="flex flex-col gap-1 border-border border-t pt-3">
          <span className="text-sm">
            {post.tokens.map((t) => (
              <span key={t.symbol} className="mr-3">
                <strong>{t.symbol}</strong> <Change value={t.change} />
              </span>
            ))}
          </span>
          <p className="line-clamp-3">{post.body}</p>
        </div>
      ))}
      {profile.jars.slice(0, 3).map((jar) => (
        <div key={jar.id} className="flex justify-between border-border border-t pt-3">
          <span className="font-medium">{jar.name}</span>
          <Change value={jar.returnSincePublish} />
        </div>
      ))}
    </SharePage>
  );
}
