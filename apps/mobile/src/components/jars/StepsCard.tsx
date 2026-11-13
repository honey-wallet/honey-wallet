import { useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { tap } from '@/lib/haptics';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

/** Ticks in the header's progress bar, the split bar's stripes in miniature. */
const TICKS = 24;

/**
 * A short checklist of steps with a header that sums it up: title, a striped bar that
 * fills as steps finish, and "3/6". Open while it runs; once done it folds to the
 * header, and a tap opens it again. The agent's research on an idea uses it.
 */
export function StepsCard({
  title,
  doneTitle,
  steps,
  at,
}: {
  title: string;
  /** The header once every step is done. */
  doneTitle: string;
  steps: readonly string[];
  /** The step in progress (steps before it are done); `steps.length` when all are. */
  at: number;
}) {
  const styles = useStyles();
  const c = useTheme();
  const done = at >= steps.length;
  const [open, setOpen] = useState<boolean | null>(null);
  // Open while working, folded when finished, unless you've chosen.
  const expanded = open ?? !done;
  const filled = Math.round((Math.min(at, steps.length) / steps.length) * TICKS);
  return (
    <Animated.View layout={LinearTransition.duration(DURATION.medium)} style={styles.card}>
      <PressableScale
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${done ? doneTitle : title}, ${Math.min(at, steps.length)} of ${steps.length}`}
        scaleTo={0.98}
        onPress={() => {
          tap();
          setOpen(!expanded);
        }}
        style={styles.head}
      >
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} color={c.textSecondary} />
        <Text style={styles.title} numberOfLines={1}>
          {done ? doneTitle : title}
        </Text>
        <View style={styles.ticks}>
          {Array.from({ length: TICKS }, (_, i) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: ticks are positions
              key={i}
              style={[styles.tick, { backgroundColor: i < filled ? c.success : c.divider }]}
            />
          ))}
        </View>
        <Text style={styles.count}>
          {Math.min(at, steps.length)}/{steps.length}
        </Text>
      </PressableScale>
      {expanded ? (
        <Animated.View
          entering={FadeIn.duration(DURATION.fast)}
          exiting={FadeOut.duration(DURATION.fast)}
          style={styles.body}
        >
          {steps.map((label, i) => {
            const state = i < at ? 'done' : i === at ? 'now' : 'next';
            return (
              <View key={label} style={styles.step}>
                {state === 'done' ? (
                  <View style={[styles.dot, { backgroundColor: c.success }]}>
                    <Icon name="check" size={11} color={c.canvas} />
                  </View>
                ) : (
                  <View
                    style={[
                      styles.dot,
                      state === 'now'
                        ? { backgroundColor: c.text }
                        : { borderWidth: 1, borderColor: c.divider },
                    ]}
                  >
                    <Text
                      style={[
                        styles.dotNum,
                        { color: state === 'now' ? c.canvas : c.textSecondary },
                      ]}
                    >
                      {i + 1}
                    </Text>
                  </View>
                )}
                <Text style={[styles.label, state !== 'now' && styles.muted]} numberOfLines={1}>
                  {label}
                </Text>
              </View>
            );
          })}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  card: { ...radius(20), backgroundColor: c.card, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, height: 48 },
  title: { flex: 1, color: c.text, fontSize: 15, fontWeight: '600' },
  ticks: { flexDirection: 'row', gap: 2, height: 12, alignItems: 'center' },
  tick: { width: 2, height: 12, borderRadius: 1 },
  count: {
    color: c.textSecondary,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    minWidth: 26,
    textAlign: 'right',
  },
  body: {
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 16,
  },
  step: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  dotNum: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  label: { flex: 1, color: c.text, fontSize: 15 },
  muted: { color: c.textSecondary },
}));
