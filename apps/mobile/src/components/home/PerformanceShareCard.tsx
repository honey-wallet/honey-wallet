import * as Sharing from 'expo-sharing';
import { forwardRef, type RefObject, useState } from 'react';
import { Text, View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { HoneyLogo } from '@/components/logo/HoneyLogo';
import { SkeletonBar, SkeletonChart } from '@/components/motion/Skeleton';
import { Sparkline } from '@/components/wallet/parts';
import { tap } from '@/lib/haptics';
import { showErrorToast } from '@/lib/toast';
import { makeStyles, radius, useTheme } from '@/theme';

export const PERFORMANCE_CARD_WIDTH = 320;
const CHART_HEIGHT = 70;
/** The line on the full-width card: taller, in proportion. */
const WIDE_CHART_HEIGHT = 110;

type Props = {
  /** Whose performance: their face, name and (for someone's public P&L) @handle. */
  name: string;
  handle?: string;
  photo?: string | null;
  seed: string;
  /** "Past week", "Today"… */
  period: string;
  /** The move over `period`, in percent (4.2 = +4.2%). */
  pct: number;
  /** Dollar values under the percentage, when you choose to show them. */
  amounts?: string;
  data: number[];
  footnote?: string;
  /** Nothing public to show: a lock where the figure and line would be. */
  locked?: string;
  /** Fill the sheet's width (someone's P&L) instead of the fixed share-card width. */
  wide?: boolean;
};

/**
 * Performance as a card to screenshot or share: who, the Honey mark, the period, the
 * move as a big percentage and its line. Your portfolio (share-portfolio) and
 * someone's public P&L (social/pnl) both draw it. The forwarded ref is the view
 * captured into the image.
 */
export const PerformanceShareCard = forwardRef<View, Props>(function PerformanceShareCard(
  { name, handle, photo, seed, period, pct, amounts, data, footnote, locked, wide },
  ref,
) {
  const styles = useStyles();
  const c = useTheme();
  // Wide: as wide as the sheet allows (its gutters), measured, so the line spans it.
  const [cardW, setCardW] = useState(PERFORMANCE_CARD_WIDTH);
  const down = pct < 0;
  return (
    // collapsable keeps it a real native view, so it can be captured.
    <View
      ref={ref}
      collapsable={false}
      style={[styles.card, wide && styles.wide]}
      onLayout={wide ? (e) => setCardW(e.nativeEvent.layout.width) : undefined}
    >
      <View style={styles.cardHead}>
        <Avatar name={name} size={28} uri={photo} seed={seed} />
        <Text style={styles.cardName} numberOfLines={1}>
          {name}
          {handle ? <Text style={styles.handle}> @{handle}</Text> : null}
        </Text>
        <HoneyLogo variant="mark" height={22} />
      </View>
      {locked ? (
        <>
          <View style={styles.locked}>
            <Icon name="lock" size={16} color={c.textSecondary} />
            <Text style={styles.lockedText}>{locked}</Text>
          </View>
          <View style={styles.lockedChart}>
            <View style={styles.baseline} />
          </View>
        </>
      ) : (
        <>
          <Text style={styles.period}>{period}</Text>
          <View style={styles.pctRow}>
            <Icon name={down ? 'down' : 'up'} size={16} color={down ? c.error : c.success} />
            <Text style={[styles.pct, { color: down ? c.error : c.success }]}>
              {Math.abs(pct).toFixed(2)}%
            </Text>
          </View>
          {amounts ? <Text style={styles.amounts}>{amounts}</Text> : null}
          <View style={styles.chart}>
            <Sparkline
              data={data}
              width={(wide ? cardW : PERFORMANCE_CARD_WIDTH) - 40}
              height={wide ? WIDE_CHART_HEIGHT : CHART_HEIGHT}
            />
          </View>
        </>
      )}
      {footnote ? <Text style={styles.footnote}>{footnote}</Text> : null}
    </View>
  );
});

/** The card while its numbers load, the same size so nothing jumps. */
export function PerformanceShareCardSkeleton({
  footnote,
  wide,
}: {
  footnote?: boolean;
  wide?: boolean;
}) {
  const styles = useStyles();
  return (
    <View style={[styles.card, wide && styles.wide]}>
      <View style={styles.cardHead}>
        <SkeletonBar width={28} height={28} radius={14} />
        <SkeletonBar width={110} height={14} />
      </View>
      <View style={styles.skeletonFigures}>
        <SkeletonBar width={70} height={12} />
        <SkeletonBar width={150} height={36} radius={10} />
      </View>
      <View style={styles.chart}>
        <SkeletonChart height={wide ? WIDE_CHART_HEIGHT : CHART_HEIGHT} />
      </View>
      {footnote ? (
        <View style={styles.skeletonFootnote}>
          <SkeletonBar width={100} height={10} />
        </View>
      ) : null}
    </View>
  );
}

/** Captures `card` as a PNG and opens the share sheet with it. */
export async function shareCardImage(card: RefObject<View | null>, dialogTitle: string) {
  tap();
  try {
    if (!(await Sharing.isAvailableAsync())) {
      showErrorToast('Sharing unavailable');
      return;
    }
    const uri = await captureRef(card, { format: 'png', quality: 1 });
    await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle, UTI: 'public.png' });
  } catch {
    showErrorToast('Couldn’t create image');
  }
}

const useStyles = makeStyles((c) => ({
  card: {
    alignSelf: 'center',
    width: PERFORMANCE_CARD_WIDTH,
    marginBottom: 12,
    padding: 20,
    ...radius(24),
    backgroundColor: c.card,
    // In dark mode the card matched the sheet behind it; a hairline gives it an edge.
    borderWidth: 1,
    borderColor: c.divider,
  },
  wide: { alignSelf: 'stretch', width: undefined },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardName: {
    flex: 1,
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
  },
  handle: {
    color: c.textSecondary,
    fontWeight: '400',
  },
  period: {
    marginTop: 18,
    color: c.textSecondary,
    fontSize: 15,
  },
  pctRow: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pct: {
    fontSize: 40,
    fontWeight: '600',
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
  amounts: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 15,
  },
  chart: {
    marginTop: 16,
  },
  // The period line plus the percentage's room, so a locked card keeps its height.
  locked: {
    marginTop: 18,
    height: 70,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  lockedText: {
    color: c.textSecondary,
    fontSize: 20,
    fontWeight: '600',
  },
  lockedChart: {
    marginTop: 16,
    height: CHART_HEIGHT,
    justifyContent: 'center',
  },
  baseline: {
    height: 2,
    borderRadius: 1,
    backgroundColor: c.raised,
  },
  footnote: {
    marginTop: 14,
    color: c.textSecondary,
    fontSize: 12,
  },
  // Period line plus the 40pt percentage, so the card keeps its height on reveal.
  skeletonFigures: {
    marginTop: 18,
    height: 70,
    gap: 10,
  },
  skeletonFootnote: {
    marginTop: 14,
    height: 15,
    justifyContent: 'center',
  },
}));
