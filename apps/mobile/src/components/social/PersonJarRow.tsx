import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { openProfile, SocialAvatar, TokenStack } from '@/components/social/parts';
import { Sparkline } from '@/components/wallet/parts';
import { pct, type SocialJar } from '@/lib/social';
import { makeStyles, useTheme } from '@/theme';

/**
 * A person and their jar as one flat row, X's "Who to follow" style (as Find people
 * lays them out): an optional rank, the face; name and @handle over the jar (its logos
 * and name); then the jar's line and its return in fixed columns, and an optional
 * trailing slot (a Follow). The face and name open the profile; the row does `onPress`.
 */
export function PersonJarRow({
  jar,
  onPress,
  rank,
  line,
  value,
  trailing,
  last,
  gutter = 18,
  ring,
}: {
  jar: SocialJar;
  onPress: () => void;
  /** Its place, in a muted numeral column. */
  rank?: number;
  /** The jar's line (its marks by default). */
  line?: number[];
  /** The return shown (since publish by default). */
  value?: number | null;
  trailing?: ReactNode;
  last?: boolean;
  /** The page's side gutter: the row bleeds through it so its press runs edge to edge. */
  gutter?: number;
  /** The surface under the logos (the page by default). */
  ring?: string;
}) {
  const styles = useStyles();
  const c = useTheme();
  const who = jar.owner;
  const shown = value === undefined ? jar.returnSincePublish : value;
  const data = line ?? jar.spark;
  const open = () => openProfile(who.handle);
  return (
    <PressableRow
      accessibilityRole="button"
      accessibilityLabel={`${rank ? `${rank}, ` : ''}${who.displayName}, ${jar.name}${
        shown == null ? '' : `, ${pct(shown)}`
      }`}
      onPress={onPress}
      style={[styles.row, { marginHorizontal: -gutter, paddingLeft: gutter }]}
    >
      {rank ? <Text style={styles.rank}>{rank}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${who.displayName}'s profile`}
        onPress={open}
      >
        <SocialAvatar who={who} size={44} />
      </Pressable>
      <View style={[styles.body, { paddingRight: gutter }, last && styles.last]}>
        <View style={styles.flex}>
          <Pressable onPress={open} style={styles.who}>
            <Text style={styles.name} numberOfLines={1}>
              {who.displayName}
            </Text>
            <Text style={styles.handle} numberOfLines={1}>
              @{who.handle}
            </Text>
          </Pressable>
          <View style={styles.jar}>
            {jar.holdingsHidden ? (
              <Icon name="lock" size={13} color={c.textSecondary} />
            ) : (
              <TokenStack
                symbols={jar.picks.map((p) => p.symbol)}
                size={16}
                ring={ring ?? c.canvas}
                max={3}
              />
            )}
            <Text style={styles.jarName} numberOfLines={1}>
              {jar.name}
            </Text>
          </View>
        </View>
        {/* Its line, then the return, each in a fixed column so every row lines up. */}
        <View style={styles.spark}>
          {data.length > 2 ? (
            <Sparkline
              data={data}
              width={44}
              height={16}
              fade={false}
              smooth
              up={(shown ?? 0) >= 0}
            />
          ) : null}
        </View>
        <Text
          style={[
            styles.ret,
            {
              color: jar.returnsHidden ? c.textSecondary : (shown ?? 0) < 0 ? c.error : c.success,
            },
          ]}
          numberOfLines={1}
        >
          {jar.returnsHidden ? '—' : shown == null ? '' : pct(shown)}
        </Text>
        {trailing}
      </View>
    </PressableRow>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  // X's rows: the hairline starts at the text, not under the face.
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rank: {
    width: 28,
    marginRight: -4,
    color: c.textSecondary,
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  body: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 64,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.divider,
  },
  last: { borderBottomWidth: 0 },
  who: { flexDirection: 'row', alignItems: 'baseline', gap: 5 },
  name: { flexShrink: 0, maxWidth: '70%', color: c.text, fontSize: 16, fontWeight: '700' },
  handle: { flexShrink: 1, color: c.textSecondary, fontSize: 15 },
  // The jar: its logos and name, quiet, truncating.
  jar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  jarName: { flex: 1, color: c.textSecondary, fontSize: 14, fontWeight: '500' },
  spark: { width: 44, height: 16 },
  ret: {
    width: 60,
    textAlign: 'right',
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
}));
