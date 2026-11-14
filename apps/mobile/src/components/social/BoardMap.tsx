import { router } from 'expo-router';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { SkeletonBar } from '@/components/motion/Skeleton';
import { HoneyBadge, SocialAvatar, TokenStack } from '@/components/social/parts';
import { Sparkline } from '@/components/wallet/parts';
import { FADE_EXTRA, TAB_BAR_HEIGHT } from '@/components/wallet/TabBar';
import {
  type BoardRange,
  HEAT_FLAT,
  HEAT_TEXT,
  heatRamp,
  mapLayout,
  mapWeights,
  type Rect,
  rangeLine,
  squarify,
  tileParts,
} from '@/lib/board';
import { tap } from '@/lib/haptics';
import { openSocialJar, pct, type SocialJar } from '@/lib/social';
import { makeStyles, useTheme } from '@/theme';
import { DURATION, EASE } from '@/theme/motion';

/*
 * The Leaderboard as a map (2026-11-13, from the user's stock-heatmap reference): a
 * squarified treemap, each jar a tile sized by its copies (or by its rank when nobody
 * has copied yet), green or red by its return, brighter for a bigger move. Each tile
 * shows the person's face on top (its biggest image), their first name on wide tiles,
 * the % in big white type, and along the bottom third the range's line with the token
 * logos in its left corner. Only as many ranks as have room for a face and the % are tiles; the others are one
 * "+N more" tile, always the last (bottom right), that opens the stack at the first.
 * Changing the range moves each tile to its new place (UI thread, 350ms); new ones fade
 * in. Reduce Motion: tiles just fade between places.
 */

/** The ring around faces on a tile, so they stand off its colour. */
const RING = 'rgba(0,0,0,0.35)';
/** The one gutter between tiles, and the one corner every tile has. */
const GAP = 4;
const RADIUS = 10;
/** The smallest tile: room for a 28pt face and a 20pt % above the chart, gutter included. */
const MIN_TILE = { w: 84 + GAP, h: 92 + GAP };
const MOVE = { duration: 350, easing: EASE.inOut };
/** Each tile's chart: white over its colour, softly filled. */
const CHART_OPACITY = 0.55;
/** The line stops this short of the tile's right edge, so its end dot shows whole. */
const CHART_INSET = 7;

/** Fills the space down to the top of the tab bar's fade (or Sign in's), so no row sits under it. */
function useFill() {
  const ref = useRef<View>(null);
  const insets = useSafeAreaInsets();
  const { height: tall } = useWindowDimensions();
  const [box, setBox] = useState({ w: 0, h: 0 });
  const measure = () =>
    ref.current?.measureInWindow((_x, y, w) => {
      const bar = Math.max(insets.bottom, 12) + 8 + TAB_BAR_HEIGHT + FADE_EXTRA;
      setBox({ w, h: Math.max(0, tall - bar - y) });
    });
  return { ref, box, measure };
}

/**
 * The box to lay a `w` × `h` map's tiles out in: a gutter wider and taller, then each
 * tile a gutter smaller, so the gutter only falls between tiles and the outer ones sit
 * flush with the map's edges.
 */
const inGutter = (w: number, h: number) => ({ x: 0, y: 0, w: w + GAP, h: h + GAP });

export function BoardMap({
  jars,
  range,
  label,
  onMore,
}: {
  jars: SocialJar[];
  range: BoardRange;
  label: string;
  /** "+N more": the ranks not on the map, from this one on. */
  onMore: (rank: number) => void;
}) {
  const styles = useStyles();
  const { ref, box, measure } = useFill();
  // Laid out once per ranking and size.
  const { count, more, rects } = useMemo(
    () => mapLayout(mapWeights(jars), inGutter(box.w, box.h), MIN_TILE),
    [jars, box.w, box.h],
  );
  const moreRect = more ? rects[count] : undefined;
  // The deep-heat ramp, scaled to the biggest gain and loss shown.
  const heat = useMemo(
    () => heatRamp(jars.slice(0, count).map((j) => j.periodReturn ?? j.returnSincePublish)),
    [jars, count],
  );
  return (
    <View ref={ref} onLayout={measure} style={styles.root}>
      <View style={{ height: box.h }}>
        {box.h > 0
          ? jars.slice(0, count).map((jar, i) => {
              const rect = rects[i];
              return rect ? (
                <Tile
                  key={jar.id}
                  jar={jar}
                  rank={i}
                  rect={rect}
                  heat={heat[i] ?? HEAT_FLAT}
                  range={range}
                  label={label}
                />
              ) : null;
            })
          : null}
        {box.h > 0 && moreRect ? (
          <MoreTile rect={moreRect} rest={jars.slice(count)} onPress={() => onMore(count)} />
        ) : null}
      </View>
    </View>
  );
}

/** The ranks that aren't tiles: a few of their faces and "+N more". Opens their list. */
function MoreTile({ rect, rest, onPress }: { rect: Rect; rest: SocialJar[]; onPress: () => void }) {
  const styles = useStyles();
  const faces = rest.slice(0, 3);
  return (
    <View
      style={[
        styles.tile,
        styles.more,
        { left: rect.x, top: rect.y, width: rect.w - GAP, height: rect.h - GAP },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${rest.length} more ranks`}
        accessibilityHint="Lists them"
        onPress={() => {
          tap();
          onPress();
        }}
        style={[styles.press, styles.column]}
      >
        <View style={styles.faces}>
          {faces.map((jar, i) => (
            <View key={jar.id} style={[styles.face, i > 0 && styles.faceOverlap]}>
              <SocialAvatar who={jar.owner} size={22} />
            </View>
          ))}
        </View>
        <Text style={styles.moreText} numberOfLines={1} adjustsFontSizeToFit>
          +{rest.length} more
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * The jar's line for the range along the bottom of its tile, under the % and never
 * behind it: smooth, white over the tile's colour with a soft fill, ending in a dot.
 * Drawn at the tile's size; it doesn't redraw while tiles move.
 */
const TileChart = memo(function TileChart({
  line,
  width,
  height,
}: {
  line: number[];
  width: number;
  height: number;
}) {
  const styles = useStyles();
  const span = width - CHART_INSET;
  // Where the line ends, as the Sparkline draws it (3pt in from its top and bottom).
  const end = useMemo(() => {
    const min = Math.min(...line);
    const max = Math.max(...line);
    const last = line[line.length - 1] ?? min;
    return max === min ? height / 2 : 3 + (1 - (last - min) / (max - min)) * (height - 6);
  }, [line, height]);
  if (span < 16 || height < 12) return null;
  return (
    <View style={[styles.chart, { height }]} pointerEvents="none">
      <Sparkline
        data={line}
        width={span}
        height={height}
        tint={HEAT_TEXT}
        smooth
        fade
        fill={0.4}
        strokeWidth={2}
      />
      <View style={[styles.chartDot, { left: span - 3, top: end - 3 }]} />
    </View>
  );
});

const Tile = memo(function Tile({
  jar,
  rank,
  rect,
  heat,
  range,
  label,
}: {
  jar: SocialJar;
  rank: number;
  rect: Rect;
  /** Its colour on the ramp. */
  heat: string;
  range: BoardRange;
  label: string;
}) {
  const styles = useStyles();
  const c = useTheme();
  const reduced = useReducedMotion();
  const value = jar.periodReturn ?? jar.returnSincePublish;
  const up = (value ?? 0) >= 0;
  const w = Math.max(0, rect.w - GAP);
  const h = Math.max(0, rect.h - GAP);
  const parts = tileParts(w, h);
  // Ends where the % says, so the line and the number agree.
  const line = useMemo(() => rangeLine(jar, range, value), [jar, range, value]);
  // Plain logos (tokens are chain-agnostic), three at most and nothing after them.
  const symbols = useMemo(
    () => [...new Set(jar.picks.map((p) => p.symbol))].slice(0, 3),
    [jar.picks],
  );

  // Where it is, eased to each new place; a new tile fades in where it lands.
  const x = useSharedValue(rect.x);
  const y = useSharedValue(rect.y);
  const tw = useSharedValue(w);
  const th = useSharedValue(h);
  const shown = useSharedValue(0);
  useEffect(() => {
    shown.set(withTiming(1, { duration: DURATION.fast, easing: EASE.ease }));
  }, [shown]);
  useEffect(() => {
    if (reduced) {
      x.set(rect.x);
      y.set(rect.y);
      tw.set(w);
      th.set(h);
      shown.set(0);
      shown.set(withTiming(1, { duration: DURATION.fast, easing: EASE.ease }));
      return;
    }
    x.set(withTiming(rect.x, MOVE));
    y.set(withTiming(rect.y, MOVE));
    tw.set(withTiming(w, MOVE));
    th.set(withTiming(h, MOVE));
  }, [rect.x, rect.y, w, h, reduced, x, y, tw, th, shown]);
  const place = useAnimatedStyle(() => ({
    opacity: shown.get(),
    left: x.get(),
    top: y.get(),
    width: tw.get(),
    height: th.get(),
  }));

  const said = value == null ? '—' : pct(value);
  const first = jar.owner.displayName.trim().split(/\s+/)[0] ?? '';

  return (
    <Animated.View style={[styles.tile, { backgroundColor: heat }, place]}>
      <TileChart line={line} width={w} height={parts.chart} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${rank + 1}, ${jar.owner.displayName}, ${jar.name}${
          value == null
            ? ''
            : `, ${up ? 'up' : 'down'} ${Math.abs(value * 100).toFixed(1)}% ${label}`
        }`}
        onPress={() => {
          tap();
          router.push({ pathname: '/jar/[id]', params: { id: openSocialJar(jar) } });
        }}
        style={styles.press}
      >
        {/* Face, name and %, centred above the chart; the face the biggest. */}
        <View style={[styles.column, { paddingBottom: parts.chart }]}>
          {/* A dark ring keeps a face apart from a tile of the same green. */}
          <View style={styles.faceRing}>
            <SocialAvatar who={jar.owner} size={parts.avatar} />
          </View>
          {/* {parts.name && first ? (
            <Text style={[styles.name, { fontSize: parts.name }]} numberOfLines={1}>
              {first}
            </Text>
          ) : null} */}
          {/* The first name, then the Honey badge on a jar Honey runs. */}
          {parts.name && first ? (
            <View style={styles.nameBadge}>
              <Text style={[styles.name, { fontSize: parts.name }]} numberOfLines={1}>
                {first}
              </Text>
              <HoneyBadge who={jar.owner} size={parts.name} color={HEAT_TEXT} />
            </View>
          ) : null}
          <Text
            style={[styles.value, { fontSize: parts.value, lineHeight: parts.valueLine }]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={20 / parts.value}
          >
            {said}
          </Text>
        </View>
      </Pressable>
      {/* The token logos, plain, in the bottom-left corner over the chart; a small lock
          when the owner hides what it holds. */}
      {jar.holdingsHidden ? (
        <View style={styles.logos} pointerEvents="none" accessibilityLabel="Holdings hidden">
          <Icon name="lock" size={Math.max(12, parts.logos * 0.6)} color={c.textSecondary} />
        </View>
      ) : symbols.length ? (
        <View style={styles.logos} pointerEvents="none">
          <TokenStack
            symbols={symbols.slice(0, parts.logoCount)}
            size={parts.logos}
            ring={c.canvas}
            max={3}
          />
        </View>
      ) : null}
      {/* The top three's place, small in the corner, plain. */}
      {rank < 3 ? <Text style={styles.rank}>{rank + 1}</Text> : null}
    </Animated.View>
  );
});

/** Loading: the map's shape in neutral tiles. */
export function BoardMapSkeleton() {
  const styles = useStyles();
  const { ref, box, measure } = useFill();
  const rects = useMemo(
    () =>
      squarify(
        Array.from({ length: 10 }, (_, i) => 1 / (i + 1) ** 0.75),
        inGutter(box.w, box.h),
      ),
    [box.w, box.h],
  );
  return (
    <View ref={ref} onLayout={measure} style={styles.root}>
      <View style={{ height: box.h }}>
        {rects.map((r) => (
          <View
            key={`${r.x}:${r.y}`}
            style={{
              position: 'absolute',
              left: r.x,
              top: r.y,
              width: r.w - GAP,
              height: r.h - GAP,
            }}
          >
            <SkeletonBar width="100%" height={Math.max(0, r.h - GAP)} radius={RADIUS} />
          </View>
        ))}
      </View>
    </View>
  );
}

/** Keeps white type legible on the brightest greens and reds. */
const LIFT = {
  textShadowColor: 'rgba(0,0,0,0.3)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 3,
} as const;

const useStyles = makeStyles(() => ({
  root: { flex: 1, minHeight: 200 },
  tile: { position: 'absolute', borderRadius: RADIUS, overflow: 'hidden' },
  press: { flex: 1 },
  column: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 6,
  },
  name: { ...LIFT, color: HEAT_TEXT, fontWeight: '600', maxWidth: '100%' },
  nameBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, maxWidth: '100%' },
  value: {
    ...LIFT,
    color: HEAT_TEXT,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.5,
    maxWidth: '100%',
  },
  more: { backgroundColor: HEAT_FLAT },
  // The chart: the tile's bottom band, full width, under the column.
  chart: { position: 'absolute', left: 0, right: 0, bottom: 0, opacity: CHART_OPACITY },
  chartDot: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: HEAT_TEXT,
  },
  logos: { position: 'absolute', left: 6, bottom: 6 },
  faces: { flexDirection: 'row' },
  // Overlapping faces, each ringed in the tile's colour.
  face: { borderRadius: 13, borderWidth: 2, borderColor: HEAT_FLAT },
  faceRing: { borderRadius: 40, borderWidth: 2, borderColor: RING },
  faceOverlap: { marginLeft: -8 },
  moreText: { color: HEAT_TEXT, fontSize: 15, fontWeight: '700' },
  rank: {
    ...LIFT,
    position: 'absolute',
    top: 6,
    left: 8,
    color: HEAT_TEXT,
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
}));
