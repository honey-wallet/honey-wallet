// Jar pieces, built from the app's existing patterns rather than a look of their own:
// rows are Explore's top-token rows, the sideways cards are Explore's favourites, and
// the numbers are Perps' tile grid. HoldingRow is the chat and strategy's own row.
import { router } from 'expo-router';
import { type ReactNode, useId, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { Avatar } from '@/components/Avatar';
import { DonutChart } from '@/components/charts/DonutChart';
import { SplitBarArt, SplitRingArcs, useSweepOnce } from '@/components/charts/SplitArt';
import { Icon } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import {
  AssetRow,
  Change,
  HeaderIconButton,
  hasAlias,
  Sparkline,
  TokenIcon,
} from '@/components/wallet/parts';
import { TOKEN_IMAGES } from '@/components/wallet/token-images';
import { TOKEN_LOGOS } from '@/components/wallet/token-logos';
import { tap } from '@/lib/haptics';
import { useTokenInfo } from '@/lib/market';
import { formatBalance, formatUsd, tokenName } from '@/lib/mock-wallet';
import { useProfile } from '@/lib/profile';
import { TEST_MODE } from '@/lib/test-mode';
import { jarReturn, jarValue, type Pick, type ThesisJar } from '@/lib/thesis';
import { tokenColor } from '@/lib/token-colors';
import { useTokenLogo } from '@/lib/token-logos';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

/** A jar's holdings as layers of its jar (bottom first), or none when they're hidden. */
export const layersOf = (jar: ThesisJar) =>
  jar.mine || jar.visibility === 'public'
    ? jar.picks.map((p) => ({ id: p.symbol, weight: p.weight, color: p.color }))
    : undefined;

/**
 * A jar's picture: a ring split by what it holds, in each holding's colour, with the
 * biggest holding's logo in the middle. Hidden holdings show a grey ring and a lock. One
 * clean mark per jar, so jars tell apart at a glance in a list.
 */
/** Arcs for a ring split by weight: rounded ends, a small gap between slices. */
function ringArcs(slices: Slice[], size: number, stroke: number, tight?: boolean) {
  const r = (size - stroke) / 2;
  const mid = size / 2;
  const total = slices.reduce((sum, p) => sum + p.weight, 0);
  // A small gap between slices, in radians; none for a single slice. Round caps eat
  // into it, so it's at least a stroke wide.
  const gap =
    slices.length < 2
      ? 0
      : tight
        ? Math.min(0.35, (stroke * 1.2) / r)
        : // Round caps reach half a stroke past each end, so this leaves a clear gap of a
          // few points between slices at any size.
          (stroke + Math.max(4, size * 0.035)) / r;
  let at = -Math.PI / 2;
  return slices.map((p) => {
    const sweep = (p.weight / (total || 1)) * Math.PI * 2;
    const a0 = at + gap / 2;
    const a1 = at + Math.max(sweep - gap / 2, gap / 2 + 0.001);
    at += sweep;
    const x0 = mid + r * Math.cos(a0);
    const y0 = mid + r * Math.sin(a0);
    const x1 = mid + r * Math.cos(a1);
    const y1 = mid + r * Math.sin(a1);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return { key: p.symbol, color: p.color, d: `M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1}` };
  });
}

/** A strategy's split as a ring of thick rounded slices, with anything in the middle. */
export function SplitRing({
  slices,
  size,
  stroke,
  tight,
  sweep,
  children,
}: {
  slices: Slice[];
  size: number;
  stroke: number;
  /** Hairline gaps, for small jar icons. */
  tight?: boolean;
  /**
   * A hero ring that draws itself in, once per session for this id (e.g. "jars-hero").
   * Rings that aren't tight icons always ease between splits (charts/SplitArt).
   */
  sweep?: string;
  children?: ReactNode;
}) {
  const c = useTheme();
  const mid = size / 2;
  const r = (size - stroke) / 2;
  const arcs = ringArcs(slices, size, stroke, tight);
  if (!tight && slices.length)
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <SplitRingArcs parts={slices} size={size} stroke={stroke} sweep={sweep} />
        {children}
      </View>
    );
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        {arcs.length === 1 ? (
          <Circle
            cx={mid}
            cy={mid}
            r={r}
            stroke={arcs[0]?.color}
            strokeWidth={stroke}
            fill="none"
          />
        ) : arcs.length ? (
          arcs.map((a) => (
            <Path
              key={a.key}
              d={a.d}
              stroke={a.color}
              strokeWidth={stroke}
              strokeLinecap="round"
              fill="none"
            />
          ))
        ) : (
          <Circle cx={mid} cy={mid} r={r} stroke={c.raised} strokeWidth={stroke} fill="none" />
        )}
      </Svg>
      {children}
    </View>
  );
}

export function JarIcon({ jar, size = 40 }: { jar: ThesisJar; size?: number }) {
  const c = useTheme();
  const picks = layersOf(jar) ? jar.picks : [];
  const stroke = Math.max(3, Math.round(size * 0.09));
  const inner = size - stroke * 2 - Math.max(2, size * 0.06) * 2;
  const top = [...picks].sort((a, b) => b.weight - a.weight)[0];
  return (
    <SplitRing slices={picks} size={size} stroke={stroke} tight>
      {top ? (
        <PickIcon pick={top} size={inner} />
      ) : (
        <View
          style={{
            width: inner,
            height: inner,
            borderRadius: inner / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: c.accentSurface,
          }}
        >
          <Icon name="lock" size={inner * 0.45} color={c.accentText} />
        </View>
      )}
    </SplitRing>
  );
}

/** Ideas to start from, shared by the Jars page and the empty chat. */
export const IDEAS: {
  title: string;
  hint: string;
  /** The picture: a two-stop gradient, and the tokens the idea would likely buy. */
  art: { from: string; to: string; tokens: string[]; sun?: boolean };
}[] = [
  {
    title: 'AI keeps eating the world',
    hint: '$500 across AI tokens you can buy here',
    // Only tokens NEAR Intents delivers (TAO and RENDER aren't on it).
    art: { from: '#312E81', to: '#7C3AED', tokens: ['NEAR', 'KAITO', 'ETH'] },
  },
  {
    title: 'Privacy coins come back',
    hint: 'Bet on money nobody can watch',
    art: { from: '#111827', to: '#4B5563', tokens: ['ZEC'] },
  },
  {
    title: 'NS is entering Kazakhstan',
    hint: 'What can I actually buy around it?',
    art: { from: '#0EA5C6', to: '#38BDF8', tokens: [], sun: true },
  },
  {
    title: 'Gold over dollars',
    hint: 'Hedge a weaker dollar, low risk',
    art: { from: '#B7791F', to: '#F6C453', tokens: ['XAUT', 'USDC'] },
  },
];

/**
 * An idea's picture: a small tile in its own colours with the tokens it points at, or,
 * for a place, a sun over the sky (Kazakhstan's flag colours, not its flag).
 */
function IdeaArt({ art, size = 68 }: { art: (typeof IDEAS)[number]['art']; size?: number }) {
  const uid = `idea${useId().replace(/[^\w]/g, '')}`;
  const coin = art.tokens.length > 2 ? size * 0.4 : size * 0.48;
  return (
    <View style={{ width: size, height: size, borderRadius: 16, overflow: 'hidden' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id={uid} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={art.from} />
            <Stop offset="1" stopColor={art.to} />
          </LinearGradient>
        </Defs>
        {/* Flat gradient, no glow in the corner (no highlight-card shine). */}
        <Rect width={size} height={size} fill={`url(#${uid})`} />
        {art.sun ? (
          <>
            {Array.from({ length: 16 }, (_, i) => {
              const a = (i / 16) * Math.PI * 2;
              const r0 = size * 0.2;
              const r1 = size * 0.3;
              return (
                <Path
                  key={a}
                  d={`M${size / 2 + r0 * Math.cos(a)} ${size * 0.46 + r0 * Math.sin(a)} L${size / 2 + r1 * Math.cos(a)} ${size * 0.46 + r1 * Math.sin(a)}`}
                  stroke="#FCD34D"
                  strokeWidth={2}
                  strokeLinecap="round"
                />
              );
            })}
            <Circle cx={size / 2} cy={size * 0.46} r={size * 0.15} fill="#FCD34D" />
            <Path
              d={`M0 ${size * 0.86} Q${size * 0.3} ${size * 0.74} ${size * 0.55} ${size * 0.84} T${size} ${size * 0.8} V${size} H0Z`}
              fill="#FFFFFF"
              opacity={0.28}
            />
          </>
        ) : null}
      </Svg>
      {art.tokens.length ? (
        <View style={styles_ideaCoins.wrap}>
          {art.tokens.map((symbol, i) => (
            <View
              key={symbol}
              style={{
                marginLeft: i ? -coin * 0.42 : 0,
                borderRadius: coin,
                borderWidth: 2,
                borderColor: 'rgba(255,255,255,0.85)',
                backgroundColor: '#FFFFFF',
                zIndex: art.tokens.length - i,
              }}
            >
              <TokenIcon symbol={symbol} size={coin} />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles_ideaCoins = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

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
            // A coin behind marks drawn without one (TAO's bare T).
            backgroundColor: '#ECECEC',
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
  // Same logo resolution as everywhere else (bundled, wrapped → coin, then the server's
  // CoinGecko list); only a token nobody has a logo for gets its letter.
  const remote = useTokenLogo(pick.symbol);
  if (TOKEN_LOGOS[pick.symbol] || hasAlias(pick.symbol) || remote)
    return <TokenIcon symbol={pick.symbol} size={size} uri={remote} />;
  // Bitmap marks sit on a light coin: some (TAO's bare T) have no circle of their own.
  if (TOKEN_IMAGES[pick.symbol])
    return (
      <View
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#E2E2E2' }}
      >
        <TokenIcon symbol={pick.symbol} size={size} />
      </View>
    );
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
 * The chat and strategy's asset row (Aave's): logo and name (no chain), a bar for its share, then the dollars and
 * the share. `onRemove` adds a remove button (editing a proposal).
 */
export function HoldingRow({
  pick,
  total,
  value,
  onRemove,
  onStep,
}: {
  pick: Pick;
  total?: number;
  /** Its dollars, when they're known exactly rather than from the rounded share. */
  value?: number;
  onRemove?: () => void;
  /** Adds −/+ to change this pick's share by `delta` points. */
  onStep?: (delta: number) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  // Outside editing, a holding opens its token's page.
  const editing = !!onRemove || !!onStep;
  const Row = editing ? View : PressableRow;
  const rowProps = editing
    ? {}
    : {
        accessibilityRole: 'button' as const,
        accessibilityLabel: `${pick.symbol}, open token`,
        onPress: () => {
          tap();
          router.push({ pathname: '/token/[symbol]', params: { symbol: pick.symbol } });
        },
      };
  return (
    <Row style={styles.holding} {...rowProps}>
      <PickIcon pick={pick} />
      <View style={styles.flex}>
        <View style={styles.holdingTop}>
          <Text style={styles.holdingName} numberOfLines={1}>
            {pick.symbol}
          </Text>
          {value !== undefined || total !== undefined ? (
            <Text style={styles.holdingValue}>
              {formatUsd(value ?? ((total ?? 0) * pick.weight) / 100)}
            </Text>
          ) : null}
        </View>
        <View style={styles.holdingTop}>
          <Text style={styles.holdingSub} numberOfLines={1}>
            {[pick.match === 'proxy' && 'Proxy', pick.name].filter(Boolean).join(' · ')}
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
    </Row>
  );
}

/**
 * A holding on a jar page, as the Wallet lists tokens (AssetRow): the token's logo, its
 * full name over the amount, then its dollars over its share. No network: tokens are
 * one thing wherever they sit. Opens the token's page.
 */
export function JarHoldingRow({
  pick,
  total,
  price,
}: {
  pick: Pick;
  /** The jar's value; this holding is its share of it. */
  total: number;
  /** The token's live price, for the amount; without one the share stands in. */
  price?: number;
}) {
  const info = useTokenInfo(pick.symbol, !TEST_MODE).info;
  const name =
    info?.name || (pick.name && pick.name !== pick.symbol ? pick.name : tokenName(pick.symbol));
  const usd = (total * pick.weight) / 100;
  const amount = price && price > 0 ? usd / price : null;
  return (
    <AssetRow
      icon={<PickIcon pick={pick} size={40} />}
      title={name}
      subtitle={
        amount === null ? `${pick.weight}% of the jar` : `${formatBalance(amount)} ${pick.symbol}`
      }
      value={formatUsd(usd)}
      detail={amount === null ? undefined : `${pick.weight}%`}
      accessibilityLabel={`${name}, open token`}
      onPress={() => {
        tap();
        router.push({ pathname: '/token/[symbol]', params: { symbol: pick.symbol } });
      }}
    />
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
 * A jar in a list, laid out like Explore's top-token rows (and Home's token rows): an
 * optional rank, its tokens (a lock when they're private), name and a quiet line about
 * it, then value (or copy fee) over its change. Rows run edge to edge so the press
 * highlight fills the width; `gutter` is the page's.
 */
export function JarRow({ jar, gutter, rank }: { jar: ThesisJar; gutter: number; rank?: number }) {
  const styles = useStyles();
  const ret = jarReturn(jar);
  const hidden = !layersOf(jar);
  const tokens = hidden ? 'Holdings hidden' : jar.picks.map((p) => p.symbol).join(', ');
  return (
    <PressableRow
      accessibilityRole="button"
      accessibilityLabel={`${jar.name}, ${signedPct(ret)}`}
      onPress={() => openJar(jar.id)}
      style={[styles.row, { marginHorizontal: -gutter, paddingHorizontal: gutter }]}
    >
      {rank ? <Text style={styles.rank}>{rank}</Text> : null}
      <JarIcon jar={jar} size={40} />
      <View style={styles.flex}>
        <Text style={styles.name} numberOfLines={1}>
          {jar.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {jar.mine ? `${people(jar)} · ${tokens}` : `${jar.creator} · ${jar.copiers} copied`}
        </Text>
      </View>
      {jar.mine ? (
        <View style={styles.end}>
          <Text style={styles.value}>{formatUsd(jarValue(jar))}</Text>
          <Change value={ret * 100} />
        </View>
      ) : (
        // Someone else's jar leads with how it did; its fee is the small print.
        <View style={styles.end}>
          <Text style={[styles.value, ret < 0 ? styles.down : styles.up]}>{signedPct(ret)}</Text>
          <Text style={styles.fee}>{jar.copyFee}% fee</Text>
        </View>
      )}
    </PressableRow>
  );
}

/** Jars as a plain list of rows, like Explore's top tokens; `ranked` numbers them. */
export function JarList({
  jars,
  gutter = 18,
  ranked,
}: {
  jars: ThesisJar[];
  gutter?: number;
  ranked?: boolean;
}) {
  return (
    <View>
      {jars.map((jar, i) => (
        <JarRow key={jar.id} jar={jar} gutter={gutter} rank={ranked ? i + 1 : undefined} />
      ))}
    </View>
  );
}

/**
 * Jars in one sideways row, as Explore shows favourite tokens: each card has the
 * tokens and name, the return big, and how many copied it. `gutter` lines the first
 * card up with the page while the row runs to the edges.
 */
export function JarCarousel({
  jars,
  gutter,
  onOpen,
}: {
  jars: ThesisJar[];
  gutter: number;
  /** Where a card goes; the jar page by default. */
  onOpen?: (jar: ThesisJar) => void;
}) {
  const styles = useStyles();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginHorizontal: -gutter, marginTop: 10 }}
      contentContainerStyle={[styles.carousel, { paddingHorizontal: gutter }]}
    >
      {jars.map((jar) => {
        const ret = jarReturn(jar);
        return (
          <PressableScale
            key={jar.id}
            accessibilityRole="button"
            accessibilityLabel={`${jar.name}, ${signedPct(ret)}`}
            onPress={() => (onOpen ? onOpen(jar) : openJar(jar.id))}
            style={styles.feature}
          >
            <View style={styles.featureTop}>
              <JarIcon jar={jar} size={36} />
              <Text style={[styles.featureValue, ret < 0 ? styles.down : styles.up]}>
                {signedPct(ret)}
              </Text>
            </View>
            <Text style={styles.featureSymbol} numberOfLines={1}>
              {jar.name}
            </Text>
            <Text style={styles.featureMeta} numberOfLines={1}>
              {jar.creator} · {jar.copiers} copied
            </Text>
            {/* How it got there: the month's line, so a card reads as a market at a glance. */}
            <View style={styles.featureLine}>
              <Sparkline data={jar.history.slice(-30)} width={136} height={34} />
            </View>
          </PressableScale>
        );
      })}
    </ScrollView>
  );
}

/** "Just you" or "3 people". */
const people = (jar: ThesisJar) =>
  jar.members.length === 1 ? 'Just you' : `${jar.members.length} people`;

/** A share of a strategy: a token, its weight and colour. */
export type Slice = { symbol: string; weight: number; color: string };

/**
 * A strategy's split as one bar of rounded, striped segments with a gap between each
 * (the hatched look of a sentiment bar), each as wide as its share.
 */
export function SplitBar({
  slices,
  height = 14,
  labels = false,
}: {
  slices: Slice[];
  height?: number;
  /** Each segment's share written in its middle. */
  labels?: boolean;
}) {
  const [width, setWidth] = useState(0);
  // Drawn by charts/SplitArt: grows in from the left and eases between splits.
  return (
    <View style={{ height }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 ? (
        <SplitBarArt parts={slices} width={width} height={height} labels={labels} />
      ) : null}
    </View>
  );
}

/** The striped split bar, then each token's dot, symbol and share (or `extra`) under it. */
export function Mix({
  picks,
  extra,
  tappable,
  trailing,
}: {
  picks: Slice[];
  /** At the far right of the legend row, e.g. a post's fee. */
  trailing?: ReactNode;
  /** In place of the share, e.g. a thesis token's move since posting. */
  extra?: (symbol: string) => ReactNode;
  /** Each token in the legend opens its coin page (a jar page; not inside a pressable post). */
  tappable?: boolean;
}) {
  const styles = useStyles();
  return (
    <View style={styles.mix}>
      <SplitBar slices={picks} />
      <View style={styles.mixLegend}>
        {picks.map((p) => {
          const item = (
            <>
              <TokenIcon symbol={p.symbol} size={16} />
              <Text style={styles.mixText}>
                {p.symbol}
                {extra ? <> {extra(p.symbol)}</> : null}
              </Text>
            </>
          );
          return tappable ? (
            <PressableScale
              key={p.symbol}
              accessibilityRole="button"
              accessibilityLabel={`${p.symbol}, open`}
              scaleTo={0.94}
              hitSlop={6}
              onPress={() => {
                tap();
                router.push({ pathname: '/token/[symbol]', params: { symbol: p.symbol } });
              }}
              style={styles.mixItem}
            >
              {item}
            </PressableScale>
          ) : (
            <View key={p.symbol} style={styles.mixItem}>
              {item}
            </View>
          );
        })}
        {trailing ? <View style={styles.mixTrailing}>{trailing}</View> : null}
      </View>
    </View>
  );
}

/**
 * One of your jars as a card on the Jars page: the jar itself, big, filled with what it
 * holds; its name, people, value and change; then the mix as a bar.
 */
export function JarCard({ jar }: { jar: ThesisJar }) {
  const styles = useStyles();
  const ret = jarReturn(jar);
  const hidden = !layersOf(jar);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${jar.name}, ${formatUsd(jarValue(jar))}, ${signedPct(ret)}`}
      scaleTo={0.98}
      onPress={() => openJar(jar.id)}
      style={styles.card}
    >
      <View style={styles.cardTop}>
        <JarIcon jar={jar} size={52} />
        <View style={styles.flex}>
          <Text style={styles.cardName} numberOfLines={2}>
            {jar.name}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {jar.sharedWallet ? jar.sharedWallet.label : people(jar)}
            {jar.copiedFrom ? ` · copied from ${jar.copiedFrom.creator}` : ''}
          </Text>
        </View>
        <View style={styles.end}>
          <Text style={styles.cardValue}>{formatUsd(jarValue(jar))}</Text>
          <Change value={ret * 100} />
        </View>
      </View>
      {hidden ? null : <Mix picks={jar.picks} />}
      {jar.openOrder ? (
        <Text style={styles.cardNote}>
          {formatUsd(jar.openOrder.amount)} limit order waiting to fill
        </Text>
      ) : null}
    </PressableScale>
  );
}

/**
 * The strategy an amount buys, small: its tokens, name and a quiet line, how it has done
 * (someone else's jar), and the split as the same bar as a jar card. Tops the
 * "How much?" sheets so you see what you're copying.
 */
export function StrategyCard({
  jar,
  picks,
  name,
  meta,
  onStep,
  nameSlot,
  split,
  children,
}: {
  jar?: ThesisJar;
  picks: Pick[];
  name: string;
  meta?: string;
  /** In place of the name, e.g. a field to rename the jar as you launch it. */
  nameSlot?: ReactNode;
  /** Show the striped split even for one token, as a Feed post's well does. */
  split?: boolean;
  /** Under the split, inside the card: e.g. the Feed's − Copy 5 + stepper. */
  children?: ReactNode;
  /** Your own picks: each token gets − and + to move its share (5% a tap). */
  onStep?: (symbol: string, delta: number) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const ret = jar && !jar.mine ? jarReturn(jar) : null;
  const hidden = jar ? !layersOf(jar) : false;
  const showSplit = (split ? picks.length > 0 : picks.length > 1) && !hidden;
  // The − / + rows open on demand, so a long split never pushes the amount and its
  // button off the screen.
  const [stepping, setStepping] = useState(false);
  // The same card a Feed post's strategy sits in: logos, name and return on top, then
  // the striped split with each token's logo and share under it.
  return (
    <View style={styles.strategy}>
      <View style={styles.strategyTop}>
        {jar ? <JarIcon jar={jar} size={34} /> : <TokenStack picks={picks} size={26} />}
        <View style={styles.flex}>
          {nameSlot ?? (
            <Text style={styles.strategyName} numberOfLines={1}>
              {name}
            </Text>
          )}
          {meta ? (
            <Text style={styles.meta} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
        {ret != null ? (
          <View
            style={[
              styles.retPill,
              {
                backgroundColor: `${ret < 0 ? c.error : c.success}${c.scheme === 'dark' ? '29' : '1F'}`,
              },
            ]}
          >
            <Text style={[styles.retText, ret < 0 ? styles.down : styles.up]}>
              {signedPct(ret)}
            </Text>
          </View>
        ) : null}
        {showSplit && onStep ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityState={{ expanded: stepping }}
            hitSlop={10}
            scaleTo={0.95}
            onPress={() => {
              tap();
              setStepping((v) => !v);
            }}
          >
            <Text style={styles.stepToggle}>{stepping ? 'Done' : 'Edit split'}</Text>
          </PressableScale>
        ) : null}
      </View>
      {showSplit && onStep && stepping ? (
        <View style={styles.mix}>
          <SplitBar
            slices={picks.map((p, i) => ({
              symbol: p.symbol,
              weight: p.weight,
              color: tokenColor(p.symbol, i),
            }))}
          />
          <View style={styles.stepRows}>
            {picks.map((p) => (
              <View key={p.symbol} style={styles.stepRow}>
                <TokenIcon symbol={p.symbol} size={24} />
                <Text style={styles.stepSymbol} numberOfLines={1}>
                  {p.symbol}
                </Text>
                <View style={p.weight <= SPLIT_MIN ? styles.stepOff : null}>
                  <HeaderIconButton
                    icon="minus"
                    label={`Less ${p.symbol}`}
                    size={30}
                    accessibilityState={{ disabled: p.weight <= SPLIT_MIN }}
                    onPress={() => onStep(p.symbol, -SPLIT_STEP)}
                  />
                </View>
                <Text style={styles.stepPct}>{p.weight}%</Text>
                <View
                  style={p.weight >= 100 - SPLIT_MIN * (picks.length - 1) ? styles.stepOff : null}
                >
                  <HeaderIconButton
                    icon="plus"
                    label={`More ${p.symbol}`}
                    size={30}
                    accessibilityState={{
                      disabled: p.weight >= 100 - SPLIT_MIN * (picks.length - 1),
                    }}
                    onPress={() => onStep(p.symbol, SPLIT_STEP)}
                  />
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : showSplit ? (
        <Mix
          picks={picks.map((p, i) => ({
            symbol: p.symbol,
            weight: p.weight,
            color: tokenColor(p.symbol, i),
          }))}
        />
      ) : null}
      {children}
    </View>
  );
}

/** A split moves 5% a tap, anywhere from 0% to 100% (no floor or cap, 2026-11-13). */
export const SPLIT_STEP = 5;
export const SPLIT_MIN = 0;

/**
 * Moves `symbol`'s share by `delta`, taking from (or giving to) the others one point at
 * a time, largest first when taking and smallest first when giving, so it stays at 100%.
 */
export function stepSplit(weights: number[], index: number, delta: number): number[] {
  const n = weights.length;
  const next = [...weights];
  const target = Math.min(
    100 - SPLIT_MIN * (n - 1),
    Math.max(SPLIT_MIN, (next[index] ?? 0) + delta),
  );
  let move = target - (next[index] ?? 0);
  next[index] = target;
  while (move !== 0) {
    let pick = -1;
    for (let k = 0; k < n; k++) {
      if (k === index) continue;
      const w = next[k] ?? 0;
      if (move > 0 && w <= SPLIT_MIN) continue;
      if (pick < 0) pick = k;
      else if (move > 0 ? w > (next[pick] ?? 0) : w < (next[pick] ?? 0)) pick = k;
    }
    if (pick < 0) break;
    next[pick] = (next[pick] ?? 0) + (move > 0 ? -1 : 1);
    move += move > 0 ? -1 : 1;
  }
  return next;
}

/**
 * What you own across all your jars, token by token: each jar's value split by its
 * mix and added up, largest first. Hidden jars are yours, so they count too.
 */
export function Exposure({ jars }: { jars: ThesisJar[] }) {
  const total = jars.reduce((s, j) => s + jarValue(j), 0);
  const by = new Map<string, { pick: Pick; value: number }>();
  for (const jar of jars) {
    const v = jarValue(jar);
    for (const p of jar.picks) {
      const row = by.get(p.symbol) ?? { pick: p, value: 0 };
      row.value += (v * p.weight) / 100;
      by.set(p.symbol, row);
    }
  }
  const rows = [...by.values()].sort((a, b) => b.value - a.value);
  if (!total || !rows.length) return null;
  return (
    <View>
      {rows.map(({ pick, value }) => (
        <HoldingRow
          key={pick.symbol}
          pick={{ ...pick, weight: Math.round((value / total) * 100) }}
          value={value}
        />
      ))}
    </View>
  );
}

/** What you own across jars as slices for a ring: each token's share of the total value. */
export function exposureSlices(jars: ThesisJar[]): Slice[] {
  const by = new Map<string, number>();
  for (const jar of jars) {
    const v = jarValue(jar);
    for (const p of jar.picks) by.set(p.symbol, (by.get(p.symbol) ?? 0) + (v * p.weight) / 100);
  }
  const total = [...by.values()].reduce((s, v) => s + v, 0);
  if (!total) return [];
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([symbol, value], i) => ({
      symbol,
      weight: Math.round((value / total) * 100),
      color: tokenColor(symbol, i),
    }));
}

/** A ring's key in a card: each slice's dot and symbol over its share, side by side. */
export function RingLegend({ slices, sweep }: { slices: Slice[]; sweep?: string }) {
  const styles = useStyles();
  // With its ring's sweep (the same id): each key rises 4pt in as the ring lands, the
  // first four 40ms apart. Otherwise, and under Reduce Motion, it's simply there.
  const sweeping = useSweepOnce(sweep);
  const reduced = useReducedMotion();
  const follow = sweeping && !reduced;
  return (
    <View style={styles.ringKey}>
      {slices.slice(0, 8).map((s, i) => (
        <Animated.View
          key={s.symbol}
          entering={
            follow
              ? FadeInDown.duration(DURATION.medium)
                  .delay(250 + Math.min(i, 3) * DURATION.stagger)
                  .easing(EASE.smoothOut)
                  .withInitialValues({ transform: [{ translateY: 4 }] })
              : undefined
          }
          style={styles.ringKeyItem}
        >
          <View style={styles.ringKeyName}>
            <TokenIcon symbol={s.symbol} size={18} />
            <Text style={styles.ringKeySymbol} numberOfLines={1}>
              {s.symbol}
            </Text>
          </View>
          <Text style={styles.ringKeyPct}>{s.weight}%</Text>
        </Animated.View>
      ))}
    </View>
  );
}

/**
 * Ideas to start a jar from, one card each with its picture; each opens the chat with it
 * asked, or, inside the chat, `onPick` asks it there.
 */
export function IdeaGrid({ onPick }: { onPick?: (title: string) => void } = {}) {
  const styles = useStyles();
  return (
    <View style={styles.ideas}>
      {IDEAS.map((idea) => (
        <PressableScale
          key={idea.title}
          accessibilityRole="button"
          scaleTo={0.97}
          onPress={() => {
            tap();
            if (onPick) onPick(idea.title);
            else router.push({ pathname: '/thesis-chat', params: { idea: idea.title } });
          }}
          style={styles.idea}
        >
          <IdeaArt art={idea.art} />
          <View style={styles.flex}>
            <Text style={styles.ideaTitle} numberOfLines={2}>
              {idea.title}
            </Text>
            <Text style={styles.ideaHint} numberOfLines={2}>
              {idea.hint}
            </Text>
          </View>
        </PressableScale>
      ))}
    </View>
  );
}

function openJar(id: string) {
  tap();
  router.push({ pathname: '/jar/[id]', params: { id } });
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  // Perps' market row.
  // Explore's market row.
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  rank: { width: 22, color: c.textSecondary, fontSize: 15, textAlign: 'center' },
  name: { color: c.text, fontSize: 16, fontWeight: '500' },
  meta: { marginTop: 2, color: c.textSecondary, fontSize: 14 },
  end: { alignItems: 'flex-end', gap: 2 },
  value: { color: c.text, fontSize: 16, fontWeight: '500', fontVariant: ['tabular-nums'] },
  // Explore's favourite-token cards.
  carousel: { gap: 8 },
  feature: { width: 164, padding: 14, gap: 4, ...radius(20), backgroundColor: c.card },
  featureTop: {
    marginBottom: 6,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  featureSymbol: { color: c.text, fontSize: 16, fontWeight: '600', lineHeight: 20 },
  featureLine: { marginTop: 8 },
  fee: { color: c.textSecondary, fontSize: 13, fontVariant: ['tabular-nums'] },
  featureValue: { fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  featureMeta: { color: c.textSecondary, fontSize: 13 },
  up: { color: c.success },
  down: { color: c.error },
  // Your jars, as cards.
  card: { padding: 16, gap: 14, ...radius(22), backgroundColor: c.card },
  strategy: { padding: 14, gap: 12, ...radius(18), backgroundColor: c.card },
  retPill: { height: 22, paddingHorizontal: 7, borderRadius: 6, justifyContent: 'center' },
  retText: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  strategyBody: { gap: 10 },
  ringKey: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    rowGap: 12,
    paddingVertical: 14,
    paddingHorizontal: 8,
    ...radius(18),
    backgroundColor: c.card,
  },
  ringKeyItem: { width: '25%', alignItems: 'center', gap: 4 },
  ringKeyName: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  ringKeySymbol: { color: c.text, fontSize: 14, fontWeight: '500', flexShrink: 1 },
  ringKeyPct: { color: c.textSecondary, fontSize: 14, fontVariant: ['tabular-nums'] },
  ringCount: { color: c.text, fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  ringLabel: { color: c.textSecondary, fontSize: 11, marginTop: -2 },
  ringLegend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 6 },
  strategyTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  strategyName: { color: c.text, fontSize: 16, fontWeight: '600' },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardName: { color: c.text, fontSize: 17, fontWeight: '600' },
  cardValue: { color: c.text, fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  cardNote: { color: c.accentText, fontSize: 13, fontWeight: '500' },
  mixTrailing: { marginLeft: 'auto', alignSelf: 'center' },
  stepRows: { gap: 4 },
  stepToggle: { color: c.accentText, fontSize: 15, fontWeight: '600' },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40 },
  stepSymbol: { flex: 1, color: c.text, fontSize: 16, fontWeight: '600' },
  stepPct: {
    width: 48,
    textAlign: 'center',
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  stepOff: { opacity: 0.4 },
  mix: { gap: 10 },
  mixLegend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 6 },
  mixItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  mixText: { color: c.text, fontSize: 13, fontWeight: '500' },
  mixPct: { color: c.textSecondary, fontWeight: '400', fontVariant: ['tabular-nums'] },
  // Ideas to start from, as the empty chat shows them.
  ideas: { gap: 10 },
  idea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 12,
    ...radius(20),
    borderWidth: 1,
    borderColor: c.divider,
  },
  ideaTitle: { color: c.text, fontSize: 16, fontWeight: '600', lineHeight: 21 },
  ideaHint: { marginTop: 3, color: c.textSecondary, fontSize: 14, lineHeight: 19 },
  // The chat and strategy's asset row.
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
