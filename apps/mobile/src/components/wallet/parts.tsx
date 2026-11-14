import type { Href } from 'expo-router';
import { type ReactElement, type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import {
  type AccessibilityState,
  Image,
  type RefreshControlProps,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Mask, Path, Rect, Stop, SvgXml } from 'react-native-svg';
import { Icon, type IconName } from '@/components/Icon';
import { AccordionChevron } from '@/components/motion/Accordion';
import { IconSwap } from '@/components/motion/IconSwap';
import { NumberPopIn } from '@/components/motion/NumberPopIn';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import { useEntrancePlaying } from '@/components/motion/Rise';
import { StickyArea } from '@/components/motion/Sticky';
import { TextsReveal } from '@/components/motion/TextsReveal';
import { NETWORK_LOGOS } from '@/components/wallet/network-logos';
import { TOKEN_IMAGES } from '@/components/wallet/token-images';
import { TOKEN_LOGOS } from '@/components/wallet/token-logos';
import { useMoney } from '@/lib/fx';
import { tap } from '@/lib/haptics';
import { CHAINS, chainSymbol, type Token } from '@/lib/mock-wallet';
import { goBackOr } from '@/lib/navigation';
import { HIDDEN_AMOUNT, toggleHideBalance, useSettings } from '@/lib/settings';
import { LANDING } from '@/lib/surface';
import { smoothPath } from '@/lib/svg-path';
import { useTokenLogo } from '@/lib/token-logos';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

/**
 * The token's full-colour coin logo; unknown tokens get their initial in a grey well. With
 * `chain`, a small network badge sits bottom-right, as in Uniswap, unless the token
 * is that network's own coin (ETH on Ethereum needs no badge).
 */
/** Wrapped or bridged tokens shown with the logo of the coin they hold one-to-one. */
const LOGO_ALIASES: Record<string, string> = {
  WETH: 'ETH',
  WBTC: 'BTC',
  cbBTC: 'BTC',
  BTCB: 'BTC',
  tBTC: 'BTC',
  hemiBTC: 'BTC',
  xBTC: 'BTC',
  wNEAR: 'NEAR',
  WSOL: 'SOL',
  wSOL: 'SOL',
  'USDC.e': 'USDC',
  USDbC: 'USDC',
  USDT0: 'USDT',
  'USDT.e': 'USDT',
  WBNB: 'BNB',
  WPOL: 'POL',
  MATIC: 'POL',
  WAVAX: 'AVAX',
  WXRP: 'XRP',
  WTRX: 'TRX',
};

/** Whether a symbol wears another coin's bundled logo (cbBTC → BTC). */
export const hasAlias = (symbol: string) => {
  const art = LOGO_ALIASES[symbol];
  return !!art && !!(TOKEN_LOGOS[art] ?? TOKEN_IMAGES[art]);
};

/** The same CoinGecko image on its other host (both serve /coins/images/…). */
function altCoinGeckoHost(url: string) {
  if (url.startsWith('https://coin-images.coingecko.com/'))
    return url.replace('https://coin-images.coingecko.com/', 'https://assets.coingecko.com/');
  if (url.startsWith('https://assets.coingecko.com/'))
    return url.replace('https://assets.coingecko.com/', 'https://coin-images.coingecko.com/');
  return '';
}

export function TokenIcon({
  symbol,
  size = 40,
  chain,
  ring,
  uri,
  assetId,
}: {
  symbol: string;
  size?: number;
  /** The token's network, worn as a badge; any name (swaps reach networks beyond `Chain`). */
  chain?: string;
  /** Colour around the badge; match the surface behind the icon. */
  ring?: string;
  /** A logo URL (https) for tokens without a bundled logo, e.g. from the token's details. */
  uri?: string | null;
  /**
   * The token's asset id. A DEX token's (`dex:<chain>:<address>`) wears only its own
   * logo, never the bundled art of whatever shares its symbol (a fake "USDC").
   */
  assetId?: string | null;
}) {
  const c = useTheme();
  const dex = !!assetId?.startsWith('dex:');
  // Wrapped and bridged copies wear their coin's logo (the network badge tells them apart).
  const art = LOGO_ALIASES[symbol] ?? symbol;
  // const xml = TOKEN_LOGOS[art] ?? NETWORK_LOGOS[art];
  const xml = dex ? undefined : (TOKEN_LOGOS[art] ?? NETWORK_LOGOS[art]);
  // A token without a logo gets its initial in a grey well, so rows still tell apart.
  // const image = TOKEN_IMAGES[art];
  const image = dex ? undefined : TOKEN_IMAGES[art];
  // No bundled art and no URL given: the server's logo list (CoinGecko) for the long tail.
  // const listed = useTokenLogo(art);
  const listed = useTokenLogo(art, assetId);
  const given = uri ?? listed;
  // A logo that won't load tries CoinGecko's other image host once, then the letter:
  // never an empty grey circle.
  const [failures, setFailures] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: start over for a new logo.
  useEffect(() => setFailures(0), [given]);
  // assets.coingecko.com first: coin-images can stall on some networks without an error,
  // which never triggers onError, so the letter would stay for good.
  const candidates = given?.startsWith('https://')
    ? given.startsWith('https://coin-images.coingecko.com/')
      ? [altCoinGeckoHost(given), given]
      : [given, altCoinGeckoHost(given)]
    : [];
  const remoteUri = [...new Set(candidates.filter(Boolean))][failures] as string | undefined;
  const remote = !xml && !image ? remoteUri : undefined;
  const letter = (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.raised,
      }}
    >
      <Text style={{ color: c.textSecondary, fontSize: size * 0.42, fontWeight: '600' }}>
        {symbol.charAt(0).toUpperCase() || '?'}
      </Text>
    </View>
  );
  const logo = xml ? (
    <SvgXml xml={xml} width={size} height={size} />
  ) : image ? (
    <Image source={image} style={{ width: size, height: size, borderRadius: size / 2 }} />
  ) : remote ? (
    // The letter sits under the downloaded logo: while it loads, or if the download
    // stalls or fails, the row still shows something, never an empty circle.
    <View style={{ width: size, height: size }}>
      {letter}
      <Image
        key={remote}
        source={{ uri: remote }}
        accessibilityIgnoresInvertColors
        onError={() => setFailures((n) => n + 1)}
        style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2 }}
      />
    </View>
  ) : (
    letter
  );
  // Any token given a network wears its badge, its own chain's coin included (ETH on
  // Ethereum), so every row and chip says where the token is.
  const network = chain ? chainSymbol(chain) : undefined;
  if (!network || !chain) return logo;
  const badge = Math.round(size * 0.42);
  return (
    <View style={{ width: size, height: size }}>
      {logo}
      <View
        style={{
          position: 'absolute',
          right: -3,
          bottom: -3,
          padding: 2,
          ...radius(badge / 3),
          backgroundColor: ring ?? c.card,
        }}
      >
        <ChainLogo chain={chain} size={badge} />
        {/* <SvgXml
          xml={TOKEN_LOGOS[network] ?? NETWORK_LOGOS[network] ?? TOKEN_LOGOS.GENERIC}
          width={badge}
          height={badge}
        /> */}
      </View>
    </View>
  );
}

/** A network's logo on its own (the badge `TokenIcon` wears), e.g. beside an amount. */
export function ChainLogo({ chain, size }: { chain: string; size: number }) {
  const network = chainSymbol(chain);
  return (
    <SvgXml
      xml={TOKEN_LOGOS[network] ?? NETWORK_LOGOS[network] ?? TOKEN_LOGOS.GENERIC}
      width={size}
      height={size}
    />
  );
}

/** "All networks": the first four network logos in a 2×2 grid, as in Uniswap. */
export function NetworkGrid({ size }: { size: number }) {
  const cell = size / 2 - 1;
  return (
    <View style={{ width: size, height: size, flexDirection: 'row', flexWrap: 'wrap', gap: 2 }}>
      {CHAINS.slice(0, 4).map((chain) => (
        <TokenIcon key={chain.name} symbol={chain.symbol} size={cell} />
      ))}
    </View>
  );
}

/** Up/down change in percent; only the triangle is coloured, as in Uniswap. */
export function Change({ value, size = 15 }: { value: number; size?: number }) {
  const c = useTheme();
  const color = value < 0 ? c.error : c.success;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
      <Icon name={value < 0 ? 'down' : 'up'} size={size * 0.6} color={color} />
      <Text
        style={{ color: c.textSecondary, fontSize: size }}
      >{`${Math.abs(value).toFixed(2)}%`}</Text>
    </View>
  );
}

/**
 * The Wallet's asset row: logo, the token's name over its amount, then its value over a
 * detail (the day's change, or a share as text).
 */
export function AssetRow({
  icon,
  title,
  subtitle,
  value,
  detail,
  onPress,
  accessibilityLabel,
  note,
  large,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  value: string;
  detail?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  /** Beside the subtitle: Home's jar icons on a token a jar holds. */
  note?: ReactNode;
  /** Home's list, at Uniswap's sizes (14 Nov: measured on the same phone, ~1.2× ours). */
  large?: boolean;
}) {
  const styles = useStyles();
  return (
    <PressableRow
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      style={[styles.tokenRow, large && styles.tokenRowLarge]}
    >
      {icon}
      <View style={styles.flex}>
        <Text style={[styles.rowTitle, large && styles.rowTitleLarge]} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.rowSubtitleLine}>
          <Text
            style={[styles.rowSubtitle, large && styles.rowSubtitleLarge, styles.shrink]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
          {note}
        </View>
      </View>
      <View style={styles.rowEnd}>
        <Text style={[styles.rowTitle, large && styles.rowTitleLarge]}>{value}</Text>
        {typeof detail === 'string' ? <Text style={styles.rowDetail}>{detail}</Text> : detail}
      </View>
    </PressableRow>
  );
}

// export function TokenRow({ token, onPress }: { token: Token; onPress?: () => void }) {
export function TokenRow({
  token,
  onPress,
  inJar,
  jarNote,
  large,
}: {
  token: Token;
  onPress?: () => void;
  /** "In AI Bubble": the jars of yours holding it, after the amount (lib/jar-holdings). */
  inJar?: string | null;
  /** The holding jars' icons, after the amount; `inJar` is then only read aloud (14 Nov). */
  jarNote?: ReactNode;
  large?: boolean;
}) {
  const money = useMoney();
  const amount = `${token.amount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${token.symbol}`;
  return (
    <AssetRow
      // icon={<TokenIcon symbol={token.symbol} />}
      icon={
        <View>
          <TokenIcon symbol={token.symbol} />
          {/* Held on several networks: how many, on the logo's corner (as Uniswap's). */}
          {(token.chains ?? 0) > 1 ? <NetworkCount count={token.chains ?? 0} /> : null}
        </View>
      }
      title={token.name}
      // subtitle={`${token.amount.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${token.symbol}`}
      // subtitle={inJar ? `${amount} · ${inJar}` : amount}
      subtitle={inJar && !jarNote ? `${amount} · ${inJar}` : amount}
      note={jarNote}
      accessibilityLabel={inJar ? `${token.name}, ${amount}, ${inJar}` : undefined}
      large={large}
      value={money.format(token.usd)}
      detail={<Change value={token.change} size={large ? 16 : 15} />}
      onPress={onPress}
    />
  );
}

/** The number of networks a token is held on, as a small tile on its logo's corner. */
function NetworkCount({ count }: { count: number }) {
  const styles = useStyles();
  return (
    <View style={styles.networkCount} accessibilityLabel={`On ${count} networks`}>
      <Text style={styles.networkCountText}>{count}</Text>
    </View>
  );
}

/** A thin rule with a centred label; it heads an accordion, so its chevron flips. */
export function LabeledDivider({
  label,
  open,
  onPress,
}: {
  label: string;
  open: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    // Before: a plain Pressable, with no sign it was pressed.
    // <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={…} style={styles.divider} hitSlop={8}>
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={styles.divider}
      hitSlop={8}
    >
      <View style={styles.rule} />
      <Text style={styles.dividerLabel}>{label}</Text>
      <AccordionChevron open={open} size={11} color={c.textSecondary} />
      <View style={styles.rule} />
    </PressableScale>
  );
}

/** A thin rule with a centred label and nothing to tap, e.g. "From an account". */
export function LabeledRule({ label }: { label: string }) {
  const styles = useStyles();
  return (
    <View style={styles.divider}>
      <View style={styles.rule} />
      <Text style={styles.dividerLabel}>{label}</Text>
      <View style={styles.rule} />
    </View>
  );
}

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** The sparkline draws in just after the balance beside it has landed. */
const SPARK_DRAW = { duration: DURATION.medium, easing: EASE.smoothOut } as const;
const SPARK_DELAY = DURATION.stagger * 2;

/**
 * Balance sparkline after Uniswap: a thin line that fades in from the left, over
 * a faint glow that fades the same way, so the chart has no hard left edge. On a
 * screen's first-visit entrance the line draws itself in left to right and the glow
 * follows; under Reduce Motion it fades in whole.
 */
/**
 * At most 24 points, each the average of its stretch: a few hundred hourly prices drawn
 * 40pt wide turn to noise, and a smooth line wants the shape, not every tick. The first
 * and last values stay exact, so the line still starts and ends where the data does.
 */
function smoothable(data: number[], most = 24) {
  if (data.length <= most) return data;
  const out = [data[0]];
  const inner = most - 2;
  const step = (data.length - 2) / inner;
  for (let i = 0; i < inner; i++) {
    const from = 1 + Math.floor(i * step);
    const to = Math.max(from + 1, 1 + Math.floor((i + 1) * step));
    let sum = 0;
    for (let j = from; j < to; j++) sum += data[j];
    out.push(sum / (to - from));
  }
  out.push(data[data.length - 1]);
  return out;
}

// Moved to lib/svg-path.ts on 14 Nov (cleanup), shared with the token share card.
// /** Catmull-Rom through the points as cubic Béziers, kept inside the points' own range. */
// function smoothPath(points: number[][]) {
//   if (points.length < 3)
//     return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
//   const ys = points.map((p) => p[1]);
//   const lo = Math.min(...ys);
//   const hi = Math.max(...ys);
//   const clamp = (v: number) => Math.min(Math.max(v, lo), hi);
//   let d = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
//   for (let i = 0; i < points.length - 1; i++) {
//     const p0 = points[i - 1] ?? points[i];
//     const p1 = points[i];
//     const p2 = points[i + 1];
//     const p3 = points[i + 2] ?? p2;
//     const c1x = p1[0] + (p2[0] - p0[0]) / 6;
//     const c1y = clamp(p1[1] + (p2[1] - p0[1]) / 6);
//     const c2x = p2[0] - (p3[0] - p1[0]) / 6;
//     const c2y = clamp(p2[1] - (p3[1] - p1[1]) / 6);
//     d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
//   }
//   return d;
// }

export function Sparkline({
  data,
  width,
  height,
  up,
  tint,
  fade = true,
  smooth = false,
  strokeWidth = 1.5,
  fill = 0.14,
}: {
  data: number[];
  width: number;
  height: number;
  /** Colour it as this direction instead of the line's own (e.g. a post's move since posting). */
  up?: boolean;
  /** One colour regardless of direction (e.g. the ink on a coloured card). */
  tint?: string;
  /** Fade the line's start in (off for tiny lines, where it reads as washed out). */
  fade?: boolean;
  /**
   * Average to ~24 points and curve through them: for tiny lines (a post's trend pill),
   * where every tick is noise. Off by default, so charts keep their real, jagged shape.
   */
  smooth?: boolean;
  strokeWidth?: number;
  /** The glow under the line: its opacity at the line, fading to none at the bottom. */
  fill?: number;
}) {
  const c = useTheme();
  const reduceMotion = useReducedMotion();
  const { play, revealed } = useEntrancePlaying();
  // Gradient and mask ids unique to this chart: on the web every SVG shares one page,
  // and a fixed id picked up another chart's mask (the share card's line vanished).
  const uid = `spark${useId().replace(/[^\w]/g, '')}`;
  const { line, length } = useMemo(() => {
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;
    // A flat day (an empty wallet) runs through the middle rather than along the floor.
    const points = (smooth ? smoothable(data) : data).map((v, i, all) => [
      (i / (all.length - 1)) * width,
      max === min ? height / 2 : 3 + (1 - (v - min) / span) * (height - 6),
    ]);
    let len = 0;
    for (let i = 1; i < points.length; i++) {
      len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    }
    if (!smooth)
      return {
        line: points
          .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`)
          .join(' '),
        length: len,
      };
    // The curve runs a little longer than its polyline: overshoot so the draw-in finishes.
    return { line: smoothPath(points), length: len * 1.15 + 2 };
  }, [data, width, height, smooth]);
  const color = tint ?? ((up ?? !(data[data.length - 1] < data[0])) ? c.success : c.error);

  const drawn = useSharedValue(play ? 0 : 1);
  useEffect(() => {
    if (!play || !revealed) return;
    drawn.value = withDelay(
      SPARK_DELAY,
      withTiming(1, reduceMotion ? { duration: DURATION.fast, easing: EASE.ease } : SPARK_DRAW),
    );
  }, [play, revealed, reduceMotion, drawn]);
  const lineProps = useAnimatedProps(() =>
    reduceMotion
      ? { strokeDashoffset: 0, strokeOpacity: drawn.value }
      : { strokeDashoffset: length * (1 - drawn.value), strokeOpacity: 1 },
  );
  // The glow trails the line, filling in over the back half of the draw.
  const glowProps = useAnimatedProps(() => ({
    opacity: reduceMotion ? drawn.value : Math.max(0, drawn.value * 2 - 1),
  }));

  // A flat day (an empty wallet): a plain dashed line you can see, not a faded one.
  if (Math.min(...data) === Math.max(...data)) {
    return (
      <Svg width={width} height={height}>
        <Path
          d={`M0 ${height / 2} L${width} ${height / 2}`}
          stroke={tint ?? c.textSecondary}
          strokeOpacity={0.5}
          strokeWidth={1.5}
          strokeDasharray={[4, 4]}
          strokeLinecap="round"
        />
      </Svg>
    );
  }

  return (
    <Svg width={width} height={height}>
      <Defs>
        {/* Horizontal fade shared by the line and the glow. */}
        <LinearGradient id={`${uid}-fadeIn`} x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor={color} stopOpacity={fade ? 0.15 : 1} />
          <Stop offset="0.4" stopColor={color} stopOpacity={1} />
        </LinearGradient>
        <LinearGradient id={`${uid}-glow`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity={fill} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </LinearGradient>
        <LinearGradient id={`${uid}-maskFade`} x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#fff" stopOpacity={0} />
          <Stop offset="0.6" stopColor="#fff" stopOpacity={1} />
        </LinearGradient>
        <Mask id={`${uid}-mask`}>
          <Rect width={width} height={height} fill={`url(#${uid}-maskFade)`} />
        </Mask>
      </Defs>
      {/* No glow on a tiny line (in a pill): it reads as a box behind it. */}
      {fade ? (
        <AnimatedPath
          d={`${line} L${width} ${height} L0 ${height} Z`}
          fill={`url(#${uid}-glow)`}
          mask={`url(#${uid}-mask)`}
          animatedProps={glowProps}
        />
      ) : null}
      <AnimatedPath
        d={line}
        stroke={`url(#${uid}-fadeIn)`}
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
        strokeDasharray={[length, length]}
        animatedProps={lineProps}
      />
    </Svg>
  );
}

/** Standard spacing for full-screen pushed pages (the counterpart of `SHEET`). */
export const SCREEN = {
  gutter: 20,
  /** Space under scrolling content, above the home indicator. */
  bottom: 32,
  /** Footer padding above and below its buttons (bottom adds the safe area). */
  footerTop: 12,
  footerBottom: 12,
} as const;

/**
 * Header for pushed screens: back chevron, centred title, optional buttons on the
 * right. `title` can be text or an element (e.g. a token logo with its symbol).
 */
export function ScreenHeader({
  title,
  fallback = LANDING,
  right,
}: {
  title: ReactNode;
  /** Where Back goes when there's nothing to go back to. */
  fallback?: Href;
  right?: ReactNode;
}) {
  const styles = useStyles();
  return (
    <View style={styles.header}>
      <View style={styles.headerSide}>
        <HeaderIconButton bare icon="chevronLeft" label="Back" onPress={() => goBackOr(fallback)} />
      </View>
      {typeof title === 'string' ? (
        <Text style={styles.headerTitle} accessibilityRole="header">
          {title}
        </Text>
      ) : (
        <View style={styles.headerTitleRow}>{title}</View>
      )}
      <View style={[styles.headerSide, styles.headerEnd]}>{right}</View>
    </View>
  );
}

/** Size of every header button, and the height of anything sitting beside one. */
export const HEADER_BUTTON = 36;

/**
 * The standard header button: an icon in a raised circle. Used for every top-bar
 * action (back, settings, notifications, scan, help, +) so they all match. The icon
 * cross-fades when `icon` changes.
 */
export function HeaderIconButton({
  icon,
  label,
  onPress,
  bare = false,
  size,
  haptic = true,
  accessibilityState,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  /** Just the icon, no circle: Back buttons and Home's header. */
  bare?: boolean;
  /**
   * The circle's size, for the same round button beside something taller or smaller
   * than a header (a stepper's − and + beside its pill). Defaults to `HEADER_BUTTON`.
   */
  size?: number;
  /** Off when `onPress` plays its own haptic (a stepper's firmer tick at its ends). */
  haptic?: boolean;
  accessibilityState?: AccessibilityState;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      scaleTo={0.97}
      onPress={() => {
        if (haptic) tap();
        onPress();
      }}
      hitSlop={bare ? 10 : 6}
      style={
        !bare && [
          styles.headerButton,
          size ? { width: size, height: size, borderRadius: size / 2 } : null,
        ]
      }
    >
      {bare ? (
        <IconSwap name={icon} size={icon === 'chevronLeft' ? 21 : 23} color={c.textSecondary} />
      ) : (
        <IconSwap
          name={icon}
          size={icon === 'chevronLeft' ? 16 : size && size < HEADER_BUTTON ? 15 : 18}
          color={c.text}
        />
      )}
    </PressableScale>
  );
}

const BALANCE_AMOUNT = { alignSelf: 'flex-start' } as const;

/**
 * The big total balance, dimmed cents and all. Tapping it hides or shows balances
 * everywhere (as in most wallets), so no extra button crowds the number.
 */
export function BalanceAmount({
  style,
  fractionStyle,
}: {
  style: StyleProp<TextStyle>;
  fractionStyle: StyleProp<TextStyle>;
}) {
  const { hideBalance } = useSettings();
  const { usd } = useWalletView();
  // In Settings' Local currency (lib/fx).
  const money = useMoney();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={hideBalance ? 'Balance hidden' : `Balance ${money.format(usd)}`}
      accessibilityHint={hideBalance ? 'Shows your balance' : 'Hides your balance'}
      scaleTo={0.97}
      onPress={() => {
        tap();
        toggleHideBalance();
      }}
      style={BALANCE_AMOUNT}
    >
      <NumberPopIn
        value={hideBalance ? HIDDEN_AMOUNT : money.format(usd)}
        style={style}
        fractionStyle={fractionStyle}
      />
    </PressableScale>
  );
}

/** Height of a pushed screen's header row (back, title, buttons). */
const HEADER_HEIGHT = 52;

/** Scroll distance over which the header's hairline fades in. */
const RULE_FADE = 8;

/**
 * The frame for full-screen pushed pages: status-bar inset, `ScreenHeader`,
 * scrolling content, an optional footer pinned to the bottom, and the bottom safe
 * area. `overlay` renders above the content but under the footer (e.g. a menu that
 * opens from a footer button).
 */
export function PushedScreen({
  title,
  fallback,
  right,
  footer,
  overlay,
  scroll = true,
  contentStyle,
  onEndReached,
  refreshControl,
  children,
}: {
  title: ReactNode;
  fallback?: Href;
  right?: ReactNode;
  footer?: ReactNode;
  overlay?: ReactNode;
  /** Called as the content nears its end, e.g. to draw the next page of a long list. */
  onEndReached?: () => void;
  /** Set false for screens that lay out their own content (e.g. a fixed panel). */
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  /** Pull to refresh, for a scrolling screen. */
  refreshControl?: ReactElement<RefreshControlProps>;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  // Above a footer, its own padding already separates them; elsewhere clear the home indicator.
  const bottom = footer ? SCREEN.footerTop : insets.bottom + SCREEN.bottom;
  // A hairline under the header fades in once the content scrolls beneath it.
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });
  const rule = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [0, RULE_FADE], [0, 1], Extrapolation.CLAMP),
  }));
  // And one over the footer while content runs on beneath it, so a cut-off section
  // reads as "more below" rather than a sliver.
  const contentH = useSharedValue(0);
  const viewportH = useSharedValue(0);
  // Within about two screens of rows from the end: ask for more (once per approach).
  const more = onEndReached;
  useAnimatedReaction(
    () => contentH.value > 0 && contentH.value - viewportH.value - scrollY.value < 600,
    (near, was) => {
      if (near && !was && more) runOnJS(more)();
    },
    [more],
  );
  const footerRule = useAnimatedStyle(() => ({
    opacity: interpolate(
      contentH.value - viewportH.value - scrollY.value,
      [0, RULE_FADE],
      [0, 1],
      Extrapolation.CLAMP,
    ),
  }));
  return (
    // Section headers marked `Sticky` pin just under the header as they scroll up.
    <StickyArea
      scrollY={scrollY}
      top={insets.top + HEADER_HEIGHT}
      style={[styles.screen, { paddingTop: insets.top }]}
    >
      <ScreenHeader title={title} fallback={fallback} right={right} />
      <Animated.View pointerEvents="none" style={[styles.headerRule, rule]} />
      {scroll ? (
        <Animated.ScrollView
          onScroll={onScroll}
          scrollEventThrottle={16}
          // Only scroll (and bounce) when there's more than fits; a page that fits
          // stays put, so dragging a chart on it scrubs instead of moving the page.
          alwaysBounceVertical={!!refreshControl}
          refreshControl={refreshControl}
          keyboardShouldPersistTaps="handled"
          onLayout={(e) => {
            viewportH.value = e.nativeEvent.layout.height;
          }}
          onContentSizeChange={(_w, h) => {
            contentH.value = h;
          }}
          contentContainerStyle={[{ paddingBottom: bottom }, contentStyle]}
        >
          {children}
        </Animated.ScrollView>
      ) : (
        <View style={[styles.flex, contentStyle]}>{children}</View>
      )}
      {overlay}
      {footer && (
        <View style={[styles.screenFooter, { paddingBottom: insets.bottom + SCREEN.footerBottom }]}>
          {scroll ? (
            <Animated.View pointerEvents="none" style={[styles.footerRule, footerRule]} />
          ) : null}
          {footer}
        </View>
      )}
    </StickyArea>
  );
}

/**
 * Centred icon, title and hint for a screen or section with nothing to show yet. Give it
 * an `action` when there's an obvious next step (Receive, Add money, Clear filters).
 * `compact` trims the padding for use inside a card or under a section label.
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  compact,
}: {
  icon: IconName;
  title: string;
  hint: string;
  action?: { label: string; onPress: () => void };
  compact?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={[styles.empty, compact && styles.emptyCompact]}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={26} color={c.accentText} />
      </View>
      <TextsReveal
        id={title}
        align="center"
        first={<Text style={styles.emptyTitle}>{title}</Text>}
        second={hint ? <Text style={styles.emptyHint}>{hint}</Text> : null}
      />
      {action && (
        <PressableScale
          accessibilityRole="button"
          onPress={() => {
            tap();
            action.onPress();
          }}
          scaleTo={0.97}
          style={styles.emptyAction}
        >
          <Text style={styles.emptyActionLabel}>{action.label}</Text>
        </PressableScale>
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    // Bleed past the screen gutter so the press highlight runs edge to edge.
    marginHorizontal: -18,
    paddingHorizontal: 18,
  },
  rowTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  rowTitleLarge: {
    fontSize: 18,
  },
  tokenRowLarge: {
    gap: 14,
    paddingVertical: 11,
  },
  rowSubtitleLine: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  shrink: {
    flexShrink: 1,
  },
  rowSubtitle: {
    // marginTop: 2,
    color: c.textSecondary,
    fontSize: 15,
  },
  rowSubtitleLarge: {
    fontSize: 16,
  },
  rowEnd: {
    alignItems: 'flex-end',
    gap: 2,
  },
  // On the logo's bottom-right corner, ringed in the page colour so it reads apart.
  networkCount: {
    position: 'absolute',
    right: -4,
    bottom: -3,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 3,
    ...radius(6),
    borderWidth: 2,
    borderColor: c.canvas,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  networkCountText: {
    color: c.text,
    fontSize: 10,
    fontWeight: '700',
  },
  // As Change's figure, for a detail that's plain text (a share).
  rowDetail: {
    color: c.textSecondary,
    fontSize: 15,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
  },
  rule: {
    flex: 1,
    height: 1,
    backgroundColor: c.divider,
  },
  dividerLabel: {
    marginLeft: 6,
    color: c.textSecondary,
    fontSize: 14,
  },
  screen: {
    flex: 1,
    backgroundColor: c.canvas,
  },
  screenFooter: {
    flexDirection: 'row',
    gap: 10,
    paddingTop: SCREEN.footerTop,
    paddingHorizontal: SCREEN.gutter,
    backgroundColor: c.canvas,
  },
  headerRule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.divider,
  },
  footerRule: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.divider,
  },
  header: {
    height: HEADER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  // Equal flexible sides keep the title centred whatever sits on the right.
  headerSide: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerEnd: {
    justifyContent: 'flex-end',
    gap: 8,
  },
  headerButton: {
    width: HEADER_BUTTON,
    height: HEADER_BUTTON,
    borderRadius: HEADER_BUTTON / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  headerTitle: {
    textAlign: 'center',
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: 32,
  },
  emptyCompact: {
    paddingVertical: 24,
    paddingHorizontal: 16,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  emptyTitle: {
    marginTop: 14,
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  emptyHint: {
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 15,
    lineHeight: 20,
    textAlign: 'center',
  },
  emptyAction: {
    marginTop: 18,
    height: 40,
    paddingHorizontal: 20,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  emptyActionLabel: {
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
  },
}));
