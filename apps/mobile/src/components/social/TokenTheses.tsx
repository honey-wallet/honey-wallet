import { Text, View } from 'react-native';
import { FeedCard } from '@/components/social/parts';
import { usePostsAbout } from '@/lib/social';
import { makeStyles } from '@/theme';

/**
 * A token page's social half: the latest theses people posted about it, with how each
 * call has done since (Fomo's research "right from your feed", turned round: the feed,
 * right on the token). `chain` is accepted for callers; posts are matched by symbol.
 */
export function TokenTheses({ symbol }: { symbol: string; chain?: string }) {
  const styles = useStyles();
  const posts = usePostsAbout(symbol);
  const shown = (posts ?? []).slice(0, 5);
  return (
    <View style={styles.wrap}>
      {shown.length ? (
        <View style={styles.list}>
          <Text style={styles.heading}>Theses on {symbol}</Text>
          {shown.map((post, i) => (
            <FeedCard
              key={post.id}
              item={{
                id: post.id,
                kind: 'thesis',
                at: post.at,
                actor: post.author,
                jar: null,
                trade: null,
                post,
                milestone: null,
              }}
              index={i}
              last={i === shown.length - 1}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  wrap: { paddingHorizontal: 20, marginTop: 16, gap: 16 },
  list: { gap: 0 },
  heading: { color: c.text, fontSize: 20, fontWeight: '700', marginBottom: 4 },
}));
