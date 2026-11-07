import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { DonutChart } from '@/components/charts/DonutChart';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { Sparkline, TokenIcon } from '@/components/wallet/parts';
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

/** A jar in a list: the jar itself, filled with what it holds, then its name and return. */
export function JarCard({ jar }: { jar: ThesisJar }) {
  const styles = useStyles();
  const c = useTheme();
  const ret = jarReturn(jar);
  const hidden = !layersOf(jar);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${jar.name}, ${signedPct(ret)}`}
      scaleTo={0.98}
      onPress={() => {
        tap();
        router.push({ pathname: '/jar/[id]', params: { id: jar.id } });
      }}
      style={styles.card}
    >
      {/* What it holds, who it's by, and how it's doing. */}
      <View style={styles.top}>
        <TokenStack picks={hidden ? [] : jar.picks} size={34} />
        <View style={styles.flex}>
          <Text style={styles.name} numberOfLines={1}>
            {jar.name}
          </Text>
          <Text style={styles.metaText} numberOfLines={1}>
            {jar.thesis}
          </Text>
        </View>
        <View style={styles.right}>
          <Text style={[styles.value, !jar.mine && { color: ret < 0 ? c.error : c.success }]}>
            {jar.mine ? formatUsd(jarValue(jar)) : signedPct(ret)}
          </Text>
          {jar.mine ? (
            <Text style={[styles.ret, { color: ret < 0 ? c.error : c.success }]}>
              {signedPct(ret)}
            </Text>
          ) : (
            <Text style={styles.metaText}>{jar.copiers} copied</Text>
          )}
        </View>
      </View>

      {hidden ? (
        <View style={styles.privateRow}>
          <Icon name="lock" size={13} color={c.textSecondary} />
          <Text style={styles.metaText}>Private · holdings hidden, returns only</Text>
        </View>
      ) : (
        <View style={styles.chips}>
          {jar.picks.map((p) => (
            <View key={p.symbol} style={styles.chip}>
              <PickIcon pick={p} size={16} />
              <Text style={styles.chipText}>{p.symbol}</Text>
              <Text style={styles.chipWeight}>{p.weight}%</Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.divider} />
      <View style={styles.bottom}>
        <People names={jar.members.map((m) => ({ id: m.id, name: m.name }))} />
        <Text style={[styles.metaText, styles.flex]} numberOfLines={1}>
          {jar.members.length === 1
            ? jar.mine
              ? 'Just you'
              : `by ${jar.creator}`
            : `${jar.members.map((m) => m.name).join(', ')}`}
        </Text>
        <Sparkline data={jar.history} width={64} height={22} />
      </View>
    </PressableScale>
  );
}

/** Overlapping token logos, like a wallet's asset stack; a lock well when hidden. */
export function TokenStack({ picks, size = 34 }: { picks: Pick[]; size?: number }) {
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
            borderColor: c.card,
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

/** A jar's mix as one thin stacked bar. */
export function MixBar({ picks }: { picks: Pick[] }) {
  const styles = useStyles();
  return (
    <View style={styles.mix}>
      {picks.map((p) => (
        <View key={p.symbol} style={{ flex: p.weight, backgroundColor: p.color }} />
      ))}
    </View>
  );
}

/** Donut plus legend: what's in the jar (or a proposal), by weight. */
export function Allocation({ picks, total }: { picks: Pick[]; total?: number }) {
  const styles = useStyles();
  return (
    <View style={styles.allocation}>
      <View style={styles.jarCol}>
        <TokenStack picks={picks} size={32} />
        {total !== undefined ? <Text style={styles.donutTotal}>{formatUsd(total)}</Text> : null}
      </View>
      <View style={styles.legend}>
        {picks.map((p) => (
          <View key={p.symbol} style={styles.legendRow}>
            <View style={[styles.dot, { backgroundColor: p.color }]} />
            <Text style={styles.legendLabel} numberOfLines={1}>
              {p.symbol}
            </Text>
            <Text style={styles.legendValue}>{p.weight}%</Text>
          </View>
        ))}
      </View>
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
        size={124}
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
            <Avatar name={m.name} size={20} seed={m.id} />
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
 * Aave's asset row: logo, name and network, a bar for its share, then the dollars and
 * the share. `onRemove` adds a remove button (editing a proposal).
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
        <View style={styles.holdingTop}>
          <Text style={styles.holdingName} numberOfLines={1}>
            {pick.symbol}
          </Text>
          {total !== undefined ? (
            <Text style={styles.holdingValue}>{formatUsd((total * pick.weight) / 100)}</Text>
          ) : null}
        </View>
        <View style={styles.holdingTop}>
          <Text style={styles.holdingSub} numberOfLines={1}>
            {pick.match === 'proxy' ? 'Proxy · ' : ''}
            {pick.name} · {pick.chain}
          </Text>
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
            <Text style={styles.holdingSub}>{pick.weight}%</Text>
          )}
        </View>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${pick.weight}%`, backgroundColor: pick.color }]} />
        </View>
      </View>
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
          <Icon name="close" size={14} color={c.textSecondary} />
        </PressableScale>
      ) : null}
    </View>
  );
}

/** Aave's stat tiles: a label over a number, two to a row. */
export function StatGrid({
  stats,
}: {
  stats: { label: string; value: string; tone?: 'up' | 'down' }[];
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.stats}>
      {stats.map((s) => (
        <View key={s.label} style={styles.stat}>
          <Text style={styles.statLabel}>{s.label}</Text>
          <Text
            style={[
              styles.statValue,
              s.tone === 'up' && { color: c.success },
              s.tone === 'down' && { color: c.error },
            ]}
            numberOfLines={1}
          >
            {s.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A signed percentage, "+12.4%". */
export const signedPct = (fraction: number) =>
  `${fraction >= 0 ? '+' : ''}${(fraction * 100).toFixed(1)}%`;

/**
 * The summary, quiet like Home's balance: a small label, the big number and its change
 * on the left, the line top right, then a few facts in one plain row.
 */
export function Summary({
  label,
  value,
  change,
  changeText,
  history,
  facts,
}: {
  label: string;
  value: string;
  /** Fraction, for the colour. */
  change: number;
  changeText: string;
  history: number[];
  facts?: { label: string; value: string }[];
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.summary}>
      <View style={styles.summaryRow}>
        <View style={styles.flex}>
          <Text style={styles.summaryLabel}>{label}</Text>
          <Text style={styles.summaryValue}>{value}</Text>
          <View style={styles.summaryChange}>
            <Icon
              name={change < 0 ? 'down' : 'up'}
              size={9}
              color={change < 0 ? c.error : c.success}
            />
            <Text style={styles.summaryChangeText}>{changeText}</Text>
          </View>
        </View>
        <Sparkline data={history.length > 1 ? history : [0, 0]} width={116} height={60} />
      </View>
      {facts?.length ? (
        <View style={styles.facts}>
          {facts.map((f, i) => (
            <View key={f.label} style={[styles.fact, i > 0 && styles.factBorder]}>
              <Text style={styles.factValue}>{f.value}</Text>
              <Text style={styles.factLabel}>{f.label}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A few facts in one plain row, split by hairlines. */
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
 * A jar in a grouped list (one card, hairlines between rows, like Settings): its tokens,
 * name, the people in it, and value with return. Details live on the jar's page.
 */
export function JarRow({ jar, first }: { jar: ThesisJar; first?: boolean }) {
  const styles = useStyles();
  const c = useTheme();
  const ret = jarReturn(jar);
  const hidden = !layersOf(jar);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${jar.name}, ${signedPct(ret)}`}
      scaleTo={0.98}
      onPress={() => {
        tap();
        router.push({ pathname: '/jar/[id]', params: { id: jar.id } });
      }}
      style={[styles.jarRow, !first && styles.jarRowBorder]}
    >
      <TokenStack picks={hidden ? [] : jar.picks} size={30} />
      <View style={styles.flex}>
        <Text style={styles.name} numberOfLines={1}>
          {jar.name}
        </Text>
        <View style={styles.rowMeta}>
          <People names={jar.members.map((m) => ({ id: m.id, name: m.name }))} size={16} />
          <Text style={styles.metaText} numberOfLines={1}>
            {jar.mine
              ? jar.members.length === 1
                ? 'Just you'
                : `${jar.members.length} people`
              : `${jar.creator} · ${jar.copiers} copied`}
          </Text>
        </View>
      </View>
      <View style={styles.right}>
        <Text style={[styles.value, !jar.mine && { color: ret < 0 ? c.error : c.success }]}>
          {jar.mine ? formatUsd(jarValue(jar)) : signedPct(ret)}
        </Text>
        {jar.mine ? (
          <Text style={[styles.ret, { color: ret < 0 ? c.error : c.success }]}>
            {signedPct(ret)}
          </Text>
        ) : (
          <Text style={styles.metaText}>{jar.copyFee}% fee</Text>
        )}
      </View>
    </PressableScale>
  );
}

/** A grouped list of jars in one card. */
export function JarList({ jars }: { jars: ThesisJar[] }) {
  const styles = useStyles();
  return (
    <View style={styles.list}>
      {jars.map((jar, i) => (
        <JarRow key={jar.id} jar={jar} first={i === 0} />
      ))}
    </View>
  );
}

/**
 * Says where a page's jar numbers come from. Until the server tracks jars, every jar,
 * value and return here is an example, and the page says so.
 */
export function SampleNote({ what = 'Jars, values and returns' }: { what?: string }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.note}>
      <Icon name="info" size={12} color={c.textSecondary} />
      <Text style={styles.noteText}>{what} are examples until jars go live.</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  ret: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 26,
    paddingLeft: 5,
    paddingRight: 10,
    borderRadius: 13,
    backgroundColor: c.raised,
  },
  chipText: { color: c.text, fontSize: 13, fontWeight: '600' },
  chipWeight: { color: c.textSecondary, fontSize: 13 },
  jarCol: { alignItems: 'center', gap: 6 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  noteText: { flexShrink: 1, color: c.textSecondary, fontSize: 12 },
  card: { padding: 16, gap: 12, ...radius(22), backgroundColor: c.card },
  summary: { gap: 16, paddingTop: 4 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  summaryLabel: { color: c.textSecondary, fontSize: 15 },
  summaryValue: {
    marginTop: 2,
    color: c.text,
    fontSize: 36,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  summaryChange: { marginTop: 2, flexDirection: 'row', alignItems: 'center', gap: 4 },
  summaryChangeText: { color: c.textSecondary, fontSize: 14, fontVariant: ['tabular-nums'] },
  facts: { flexDirection: 'row', paddingVertical: 12, ...radius(18), backgroundColor: c.card },
  fact: { flex: 1, paddingHorizontal: 14, gap: 2 },
  factBorder: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: c.divider },
  factValue: { color: c.text, fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  factLabel: { color: c.textSecondary, fontSize: 13 },
  list: { paddingHorizontal: 16, ...radius(20), backgroundColor: c.card },
  jarRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  jarRowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.divider },
  rowMeta: { marginTop: 3, flexDirection: 'row', alignItems: 'center', gap: 6 },
  privateRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.divider },
  hero: { padding: 20, gap: 18, ...radius(28), backgroundColor: c.primary },
  heroRow: { flexDirection: 'row', alignItems: 'stretch', gap: 12 },
  heroLabel: { color: c.onPrimary, opacity: 0.7, fontSize: 14, fontWeight: '500' },
  heroValue: {
    marginTop: 4,
    color: c.onPrimary,
    fontSize: 32,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  heroTag: {
    marginTop: 10,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
    backgroundColor: c.onPrimary,
  },
  heroTagText: { color: c.primary, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  bars: { width: 84, height: 88, flexDirection: 'row', alignItems: 'flex-end', gap: 5 },
  bar: { flex: 1, borderRadius: 999, backgroundColor: c.onPrimary, opacity: 0.14 },
  barNow: { opacity: 1, backgroundColor: '#FFFFFF' },
  heroStats: { flexDirection: 'row', gap: 8 },
  heroStat: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 2,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  heroStatValue: {
    color: c.onPrimary,
    fontSize: 17,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  heroStatLabel: { color: c.onPrimary, opacity: 0.7, fontSize: 12 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  stepGlyph: { color: c.text, fontSize: 16, fontWeight: '600', lineHeight: 18 },
  stepValue: {
    minWidth: 36,
    textAlign: 'center',
    color: c.text,
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  holding: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  holdingTop: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  holdingName: { flexShrink: 1, color: c.text, fontSize: 16, fontWeight: '600' },
  holdingValue: { color: c.text, fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  holdingSub: {
    flexShrink: 1,
    marginTop: 1,
    color: c.textSecondary,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  track: {
    marginTop: 8,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.raised,
    overflow: 'hidden',
  },
  fill: { height: 4, borderRadius: 2 },
  remove: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: {
    flexGrow: 1,
    flexBasis: '45%',
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 4,
    ...radius(16),
    backgroundColor: c.card,
  },
  statLabel: { color: c.textSecondary, fontSize: 13 },
  statValue: { color: c.text, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  top: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  name: { color: c.text, fontSize: 17, fontWeight: '600' },
  meta: { marginTop: 3, flexDirection: 'row', alignItems: 'center', gap: 5 },
  metaText: { flexShrink: 1, color: c.textSecondary, fontSize: 13 },
  right: { alignItems: 'flex-end', gap: 2 },
  value: { color: c.text, fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  thesis: { marginTop: 4, color: c.textSecondary, fontSize: 13 },
  bottom: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  hidden: { flex: 1, color: c.textSecondary, fontSize: 13 },
  spark: { width: 72 },
  mix: { flex: 1, height: 8, flexDirection: 'row', gap: 2, overflow: 'hidden', borderRadius: 4 },
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
  legend: { flex: 1, gap: 10 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { flex: 1, color: c.text, fontSize: 15 },
  legendValue: { color: c.textSecondary, fontSize: 15, fontVariant: ['tabular-nums'] },
}));
