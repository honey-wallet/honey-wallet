import { Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { PressableScale } from '@/components/motion/PressableScale';
import { openProfile, SocialAvatar } from '@/components/social/parts';
import { useFriendsHolding } from '@/lib/social';
import { makeStyles, radius } from '@/theme';
import { DURATION } from '@/theme/motion';

/**
 * "3 people you follow hold this", with their faces, on a token's page. Renders
 * nothing when signed out or when nobody you follow holds it.
 */
export function FriendsHolding({ symbol }: { symbol: string }) {
  const styles = useStyles();
  const holders = useFriendsHolding(symbol);
  if (!holders?.total) return null;
  const faces = holders.people.slice(0, 4);
  const first = holders.people[0];
  const others = holders.total - 1;
  return (
    <Animated.View entering={FadeIn.duration(DURATION.medium)} style={styles.wrap}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`${holders.total} people you follow hold ${symbol}`}
        scaleTo={0.98}
        onPress={() => first && openProfile(first.handle)}
        style={styles.card}
      >
        <View style={styles.faces}>
          {faces.map((who, i) => (
            <View key={who.handle} style={[styles.face, i > 0 && styles.overlap]}>
              <SocialAvatar who={who} size={28} />
            </View>
          ))}
        </View>
        <Text style={styles.text} numberOfLines={2}>
          <Text style={styles.strong}>@{first?.handle}</Text>
          {others > 0 ? ` and ${others} ${others === 1 ? 'other' : 'others'} you follow` : ''}
          {` hold${holders.total === 1 ? 's' : ''} ${symbol}`}
        </Text>
      </PressableScale>
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  wrap: { paddingHorizontal: 20, marginTop: 16 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    ...radius(18),
    backgroundColor: c.card,
  },
  faces: { flexDirection: 'row' },
  face: { borderRadius: 16, borderWidth: 2, borderColor: c.card },
  overlap: { marginLeft: -10 },
  text: { flex: 1, color: c.textSecondary, fontSize: 14, lineHeight: 19 },
  strong: { color: c.text, fontWeight: '600' },
}));
