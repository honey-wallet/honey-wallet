import { type ReactNode, useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import { Icon } from '@/components/Icon';
import { SplitRing } from '@/components/jars/JarParts';
import { Trend } from '@/components/social/parts';
import { Sparkline, TokenIcon } from '@/components/wallet/parts';
import { COPY_FEES } from '@/lib/surface';
import { tokenColor } from '@/lib/token-colors';
import { makeStyles, radius, useTheme } from '@/theme';

const GAP = 10;
/** A tile's least height to its width: a little taller than square (two-line titles grow it,
 * and its row partner stretches to match). */
const TILE_RATIO = 1.1;
/** Inside a tile: padding, and the share of its height the picture takes. */
const PAD = 14;
const ART_SHARE = 0.55;
/** A line that rises, with the dips a real one has. */
const RISING = [100, 101, 100.4, 102, 101.6, 103.5, 103, 105, 104.4, 106.8, 108, 107.2, 110, 112];

/** What a jar gives you, a tile each. Every one is something the app does today. */
const TILES: { title: string; hint: string; art: (w: number, h: number) => ReactNode }[] = [
  {
    title: 'Your split',
    hint: 'Change any weight before you buy.',
    art: (_w, h) => <SplitArt size={h} />,
  },
  {
    title: 'One approval',
    hint: 'Every token, across chains.',
    art: (w, h) => <ApprovalArt w={w} h={h} />,
  },
  {
    title: 'Copy what works',
    hint: 'Public jars show their return.',
    art: (w, h) => <CopyArt w={w} h={h} />,
  },
  // Copy fees aren't charged yet (lib/surface COPY_FEES): outside test mode the last tile
  // says who holds a jar's tokens instead.
  COPY_FEES
    ? {
        title: 'Creators earn when you do',
        hint: 'A cut of profit, never of a loss.',
        art: (w) => <FeeArt w={w} />,
      }
    : {
        title: 'Held by you',
        hint: 'Tokens sit in your wallet. Keys stay on your phone.',
        art: () => <KeysArt />,
      },
];

/**
 * How jars work, after the Earn page's grid: four tiles, two to a row, each a picture
 * drawn from the app's own pieces (the split ring, chain logos, a rising line, the fee
 * bar) over a title and one line. Static: nothing here is a button. `first` drops the
 * space above it, for when it leads the page.
 */
export function JarGuide({ first }: { first?: boolean }) {
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  const tile = (width - GAP) / 2;
  const tileH = tile * TILE_RATIO;
  const artW = tile - PAD * 2;
  const artH = tileH * ART_SHARE - PAD;
  return (
    <View style={first ? undefined : styles.wrap}>
      <Text style={styles.heading}>How jars work</Text>
      <View style={styles.grid} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0
          ? TILES.map((t) => (
              <View key={t.title} style={[styles.tile, { width: tile, minHeight: tileH }]}>
                <View style={[styles.art, { height: artH }]}>{t.art(artW, artH)}</View>
                <Text style={styles.title} numberOfLines={2}>
                  {t.title}
                </Text>
                <Text style={styles.hint} numberOfLines={2}>
                  {t.hint}
                </Text>
              </View>
            ))
          : null}
      </View>
    </View>
  );
}

/** The split ring with the three logos it holds in its middle. */
function SplitArt({ size }: { size: number }) {
  const styles = useStyles();
  const picks = ['NEAR', 'ETH', 'SOL'];
  const weights = [50, 30, 20];
  const ring = Math.min(size, 96);
  return (
    <SplitRing
      slices={picks.map((symbol, i) => ({
        symbol,
        weight: weights[i] ?? 0,
        color: tokenColor(symbol, i),
      }))}
      size={ring}
      stroke={Math.round(ring / 8)}
    >
      <View style={styles.logos}>
        {picks.map((symbol, i) => (
          <View key={symbol} style={i ? styles.tuck : undefined}>
            <TokenIcon symbol={symbol} size={Math.round(ring / 4.4)} />
          </View>
        ))}
      </View>
    </SplitRing>
  );
}

/** Three chains' logos, their lines meeting in one tick. */
function ApprovalArt({ w, h }: { w: number; h: number }) {
  const styles = useStyles();
  const c = useTheme();
  const chains = ['ETH', 'SOL', 'NEAR'];
  const logo = 26;
  const tick = 34;
  const ys = [logo / 2, h / 2, h - logo / 2];
  return (
    <View style={{ width: w, height: h }}>
      <Svg width={w} height={h} style={styles.abs}>
        {ys.map((y) => (
          <Line
            key={y}
            x1={logo}
            y1={y}
            x2={w - tick / 2}
            y2={h / 2}
            stroke={c.divider}
            strokeWidth={2}
            strokeLinecap="round"
          />
        ))}
      </Svg>
      {chains.map((symbol, i) => (
        <View key={symbol} style={[styles.abs, { left: 0, top: (ys[i] ?? 0) - logo / 2 }]}>
          <TokenIcon symbol={symbol} size={logo} />
        </View>
      ))}
      <View
        style={[
          styles.abs,
          styles.tick,
          { right: 0, top: h / 2 - tick / 2, width: tick, height: tick, borderRadius: tick / 2 },
        ]}
      >
        <Icon name="check" size={18} color={c.canvas} />
      </View>
    </View>
  );
}

/** A rising line with its return in the feed's pill. */
function CopyArt({ w, h }: { w: number; h: number }) {
  const styles = useStyles();
  return (
    <View style={[styles.copyArt, { width: w, height: h }]}>
      <View style={styles.copyPill}>
        <Trend value={0.12} />
      </View>
      <Sparkline data={RISING} width={w} height={Math.max(h - 32, 24)} strokeWidth={2.5} />
    </View>
  );
}

/** A profit bar: most of it yours, a honey slice the creator's fee, under a shield. */
/** Your keys, in the same round well as the fee's shield. */
function KeysArt() {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.shield}>
      <Icon name="key" size={20} color={c.accentText} />
    </View>
  );
}

function FeeArt({ w }: { w: number }) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.feeArt}>
      <View style={styles.shield}>
        <Icon name="shield" size={20} color={c.accentText} />
      </View>
      <View style={[styles.bar, { width: w }]}>
        <View style={[styles.barPart, styles.barYou]}>
          <Text style={[styles.barText, styles.barTextOnGreen]}>profit</Text>
        </View>
        <View style={[styles.barPart, styles.barFee]}>
          <Text style={styles.barText}>fee</Text>
        </View>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  abs: { position: 'absolute' },
  wrap: { marginTop: 28 },
  heading: { color: c.textSecondary, fontSize: 15, marginBottom: 10 },
  // Two to a row, 10pt apart, like the Earn page's grid.
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GAP },
  tile: { padding: PAD, ...radius(20), backgroundColor: c.card },
  art: { alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  title: { color: c.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  hint: { marginTop: 3, color: c.textSecondary, fontSize: 13, lineHeight: 17 },
  logos: { flexDirection: 'row' },
  tuck: { marginLeft: -6 },
  tick: { alignItems: 'center', justifyContent: 'center', backgroundColor: c.success },
  copyArt: { justifyContent: 'flex-end', gap: 8 },
  copyPill: { alignSelf: 'flex-end' },
  feeArt: { alignItems: 'center', gap: 12 },
  shield: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  bar: { flexDirection: 'row', height: 30, gap: 3 },
  barPart: { justifyContent: 'center', alignItems: 'center', ...radius(9) },
  barYou: { flex: 3, backgroundColor: c.success },
  barFee: { flex: 1, backgroundColor: c.primary },
  barText: { color: c.onPrimary, fontSize: 12, fontWeight: '700' },
  // The page colour reads on the success green in both themes.
  barTextOnGreen: { color: c.canvas },
}));
