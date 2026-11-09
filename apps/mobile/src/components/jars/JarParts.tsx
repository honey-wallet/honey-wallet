// Jar pieces, built from the app's existing patterns rather than a look of their own:
// rows are Perps' market rows and Home's token rows, the numbers are Perps' tile grid,
// and holdings read like the related-market rows on a Perps or Predict page.
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { DonutChart } from '@/components/charts/DonutChart';
import { Icon } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { Change, TokenIcon } from '@/components/wallet/parts';
import { TOKEN_IMAGES } from '@/components/wallet/token-images';
import { TOKEN_LOGOS } from '@/components/wallet/token-logos';
import { tap } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
import { useProfile } from '@/lib/profile';
import { jarReturn, jarValue, type Pick, type ThesisJar } from '@/lib/thesis';
import { makeStyles, radius, useTheme } from '@/theme';

/** A jar's holdings as layers of its jar (bottom first), or none when they're hidden. */
export const layersOf = (jar: ThesisJar) =>
  jar.mine || jar.visibility === 'public'
    ? jar.picks.map((p) => ({ id: p.symbol, weight: p.weight, color: p.color }))
    : undefined;

/** Who can see a jar, in the words the launch step uses. */
export const visibilityLabel = (jar: ThesisJar) =>
  jar.visibility === 'public'
    ? 'Public'
    : jar.visibility === 'private'
      ? 'Returns only'
      : 'Members only';

/**
 * Overlapping token logos, as Earn shows a vault's exposure; a lock well when hidden.
 * `ring` is the surface behind the stack (the page on a plain row, the card in a card).
 */
export function TokenStack({
  picks,
  size = 34,
  ring,
}: {
  picks: Pick[];
  size?: number;
  ring?: string;
}) {
  const c = useTheme();
  if (!picks.length)
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: c.accentSurface,
        }}
      >
        <Icon name="lock" size={size * 0.45} color={c.accentText} />
      </View>
    );
  const shown = picks.slice(0, 3);
  const overlap = size * 0.38;
  return (
    <View style={{ width: size + (shown.length - 1) * (size - overlap), height: size }}>
      {shown.map((p, i) => (
        <View
          key={p.symbol}
          style={{
            position: 'absolute',
            left: i * (size - overlap),
            borderRadius: size / 2 + 2,
            borderWidth: 2,
            borderColor: ring ?? c.card,
            top: -2,
            zIndex: shown.length - i,
          }}
        >
          <PickIcon pick={p} size={size} />
        </View>
      ))}
    </View>
  );
}

/** Participants' faces, overlapping, with a +N when there are more. */
export function People({
  names,
  size = 24,
}: {
  names: { id: string; name: string }[];
  size?: number;
}) {
  const c = useTheme();
  // You show as your own face, as on Home.
  const profile = useProfile();
  const shown = names.slice(0, 4);
  return (
    <View style={{ flexDirection: 'row' }}>
      {shown.map((m, i) => (
        <View
          key={m.id}
          style={{
            marginLeft: i ? -size * 0.3 : 0,
            borderRadius: size,
            borderWidth: 2,
            borderColor: c.card,
            zIndex: shown.length - i,
          }}
        >
          {m.id === 'me' ? (
            <Avatar name={m.name} size={size} uri={profile.photo} seed={profile.avatarSeed} />
          ) : (
            <Avatar name={m.name} size={size} seed={m.id} />
          )}
        </View>
      ))}
      {names.length > shown.length ? (
        <View
          style={{
            marginLeft: -size * 0.3,
            width: size + 4,
            height: size + 4,
            borderRadius: size,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: c.raised,
            borderWidth: 2,
            borderColor: c.card,
          }}
        >
          <Text style={{ color: c.text, fontSize: 11, fontWeight: '700' }}>
            +{names.length - shown.length}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** Who owns what in a shared jar, as a donut of members. */
const MEMBER_COLORS = ['#F5A524', '#2775CA', '#9945FF', '#00C08B', '#E5484D', '#8C96A3'];
export function Owners({ jar }: { jar: ThesisJar }) {
  const styles = useStyles();
  const total = jar.members.reduce((s, m) => s + m.units, 0) || 1;
  return (
    <View style={styles.allocation}>
      <DonutChart
        size={112}
        segments={jar.members
          .filter((m) => !m.invited)
          .map((m, i) => ({
            id: m.id,
            value: m.units,
            color: MEMBER_COLORS[i % MEMBER_COLORS.length] as string,
          }))}
      >
        <Text style={styles.donutTotal}>{jar.members.length}</Text>
        <Text style={styles.donutLabel}>owners</Text>
      </DonutChart>
      <View style={styles.legend}>
        {jar.members.map((m, i) => (
          <View key={m.id} style={styles.legendRow}>
            <View
              style={[styles.dot, { backgroundColor: MEMBER_COLORS[i % MEMBER_COLORS.length] }]}
            />
            <Text style={styles.legendLabel} numberOfLines={1}>
              {m.name}
            </Text>
            <Text style={styles.legendValue}>
              {m.invited ? 'Invited' : `${((m.units / total) * 100).toFixed(0)}%`}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** A pick's logo: the token's own when Honey has one, else its initial on its colour. */
export function PickIcon({ pick, size = 36 }: { pick: Pick; size?: number }) {
  if (TOKEN_LOGOS[pick.symbol] || TOKEN_IMAGES[pick.symbol])
    return <TokenIcon symbol={pick.symbol} size={size} />;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: `${pick.color}26`,
      }}
    >
      <Text style={{ color: pick.color, fontSize: size * 0.42, fontWeight: '700' }}>
        {pick.symbol.charAt(0)}
      </Text>
    </View>
  );
}

/**
 * A holding, laid out like the related-market rows on a Perps page: logo, symbol over
 * its name and network, then dollars over its share. `onStep` swaps the share for −/+
 * and `onRemove` adds a remove button (editing a strategy).
 */
export function HoldingRow({
  pick,
  total,
  onRemove,
  onStep,
}: {
  pick: Pick;
  total?: number;
  onRemove?: () => void;
  /** Adds −/+ to change this pick's share by `delta` points. */
  onStep?: (delta: number) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.holding}>
      <PickIcon pick={pick} />
      <View style={styles.flex}>
        <Text style={styles.holdingName} numberOfLines={1}>
          {pick.symbol}
        </Text>
        <Text style={styles.holdingSub} numberOfLines={1}>
          {pick.match === 'proxy' ? 'Proxy · ' : ''}
          {pick.name} · {pick.chain}
        </Text>
      </View>
      {onStep ? (
        <View style={styles.stepper}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Less ${pick.symbol}`}
            hitSlop={6}
            onPress={() => {
              tap();
              onStep(-5);
            }}
            style={styles.stepButton}
          >
            <Text style={styles.stepGlyph}>−</Text>
          </PressableScale>
          <Text style={styles.stepValue}>{pick.weight}%</Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`More ${pick.symbol}`}
            hitSlop={6}
            onPress={() => {
              tap();
              onStep(5);
            }}
            style={styles.stepButton}
          >
            <Text style={styles.stepGlyph}>+</Text>
          </PressableScale>
        </View>
      ) : (
        <View style={styles.end}>
          {total !== undefined ? (
            <Text style={styles.holdingValue}>{formatUsd((total * pick.weight) / 100)}</Text>
          ) : null}
          <Text style={total === undefined ? styles.holdingValue : styles.holdingSub}>
            {pick.weight}%
          </Text>
        </View>
      )}
      {onRemove ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`Remove ${pick.symbol}`}
          hitSlop={10}
          onPress={() => {
            tap();
            onRemove();
          }}
          style={styles.remove}
        >
          <Icon name="close" size={12} color={c.textSecondary} />
        </PressableScale>
      ) : null}
    </View>
  );
}

/** A signed percentage, "+12.4%". */
export const signedPct = (fraction: number) =>
  `${fraction >= 0 ? '+' : ''}${(fraction * 100).toFixed(1)}%`;

/**
 * The Perps page's market tiles: one grey card split into tiles by the page's colour,
 * a grey label over each number. Four make a 2×2 grid; fewer share one row.
 */
export function Tiles({
  tiles,
}: {
  tiles: { label: string; value: string; hint?: string; tone?: 'up' | 'down' }[];
}) {
  const styles = useStyles();
  const c = useTheme();
  const grid = tiles.length === 4;
  return (
    <View style={styles.grid}>
      {tiles.map((t, i) => (
        <View
          key={t.label}
          style={[
            styles.tile,
            grid ? styles.tileHalf : styles.flex,
            (grid ? i % 2 === 0 : i < tiles.length - 1) && styles.tileRight,
            grid && i < 2 && styles.tileBottom,
          ]}
        >
          <Text style={styles.tileLabel}>{t.label}</Text>
          <Text
            style={[
              styles.tileValue,
              t.tone === 'up' && { color: c.success },
              t.tone === 'down' && { color: c.error },
            ]}
            numberOfLines={1}
          >
            {t.value}
          </Text>
          {t.hint ? <Text style={styles.tileHint}>{t.hint}</Text> : null}
        </View>
      ))}
    </View>
  );
}

/** A few facts in one plain row, split by hairlines (inside a card, e.g. the chat's). */
export function Facts({ facts }: { facts: { label: string; value: string }[] }) {
  const styles = useStyles();
  return (
    <View style={styles.facts}>
      {facts.map((f, i) => (
        <View key={f.label} style={[styles.fact, i > 0 && styles.factBorder]}>
          <Text style={styles.factValue}>{f.value}</Text>
          <Text style={styles.factLabel}>{f.label}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * A jar in a list, laid out like Home's token rows (and Perps' market rows): its
 * tokens (a lock when they're private), name and a quiet line about it, then value
 * and change.
 * Rows run edge to edge so the press highlight fills the width; `gutter` is the page's.
 */
export function JarRow({ jar, gutter }: { jar: ThesisJar; gutter: number }) {
  const styles = useStyles();
  const c = useTheme();
  const ret = jarReturn(jar);
  const hidden = !layersOf(jar);
  return (
    <PressableRow
      accessibilityRole="button"
      accessibilityLabel={`${jar.name}, ${signedPct(ret)}`}
      onPress={() => {
        tap();
        router.push({ pathname: '/jar/[id]', params: { id: jar.id } });
      }}
      style={[styles.row, { marginHorizontal: -gutter, paddingHorizontal: gutter }]}
    >
      <TokenStack picks={hidden ? [] : jar.picks} size={36} ring={c.canvas} />
      <View style={styles.flex}>
        <Text style={styles.name} numberOfLines={1}>
          {jar.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {jar.mine
            ? jar.members.length === 1
              ? 'Just you'
              : `${jar.members.length} people`
            : `${jar.creator} · ${jar.copiers} copied`}
        </Text>
      </View>
      <View style={styles.end}>
        <Text style={styles.value}>
          {jar.mine ? formatUsd(jarValue(jar)) : `${jar.copyFee}% fee`}
        </Text>
        <Change value={ret * 100} />
      </View>
    </PressableRow>
  );
}

/** Jars as a plain list of rows, like Home's tokens and the Perps markets. */
export function JarList({ jars, gutter = 18 }: { jars: ThesisJar[]; gutter?: number }) {
  return (
    <View>
      {jars.map((jar) => (
        <JarRow key={jar.id} jar={jar} gutter={gutter} />
      ))}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  // Perps' market row.
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  name: { color: c.text, fontSize: 17, fontWeight: '600' },
  meta: { marginTop: 2, color: c.textSecondary, fontSize: 14 },
  end: { alignItems: 'flex-end', gap: 2 },
  value: { color: c.text, fontSize: 16, fontWeight: '500', fontVariant: ['tabular-nums'] },
  // Perps' related-market row.
  holding: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 12 },
  holdingName: { color: c.text, fontSize: 16, fontWeight: '600' },
  holdingValue: { color: c.text, fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  holdingSub: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  stepGlyph: { color: c.text, fontSize: 16, fontWeight: '600', lineHeight: 18 },
  stepValue: {
    minWidth: 40,
    textAlign: 'center',
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  remove: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  // Perps' tile grid: the page's colour between tiles, so one grey card reads as several.
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    ...radius(20),
    overflow: 'hidden',
    backgroundColor: c.card,
  },
  tile: { padding: 16, gap: 4 },
  tileHalf: { width: '50%' },
  tileRight: { borderRightWidth: 2, borderColor: c.canvas },
  tileBottom: { borderBottomWidth: 2, borderColor: c.canvas },
  tileLabel: { color: c.textSecondary, fontSize: 14 },
  tileValue: { color: c.text, fontSize: 19, fontWeight: '600', fontVariant: ['tabular-nums'] },
  tileHint: { color: c.textSecondary, fontSize: 12 },
  facts: { flexDirection: 'row', paddingVertical: 12, ...radius(18), backgroundColor: c.card },
  fact: { flex: 1, paddingHorizontal: 14, gap: 2 },
  factBorder: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: c.divider },
  factValue: { color: c.text, fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  factLabel: { color: c.textSecondary, fontSize: 13 },
  allocation: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    padding: 16,
    ...radius(20),
    backgroundColor: c.card,
  },
  donutTotal: { color: c.text, fontSize: 16, fontWeight: '600' },
  donutLabel: { color: c.textSecondary, fontSize: 12 },
  legend: { flex: 1, gap: 12 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { flex: 1, color: c.text, fontSize: 15 },
  legendValue: { color: c.textSecondary, fontSize: 15, fontVariant: ['tabular-nums'] },
}));
