import { type ReactNode, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { tap } from '@/lib/haptics';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

export type StepState = 'done' | 'now' | 'next';

/**
 * A short checklist of steps with a header that sums it up: title, a striped bar that
 * fills as steps finish, and "3/6". Open while it runs; once done it folds to the
 * header, and a tap opens it again. The agent's research on an idea uses it, with each
 * step's time on the right and its live updates under the step in progress.
 */
export function StepsCard({
  title,
  doneTitle,
  steps,
  at,
  note,
  times,
  detail,
}: {
  title: string;
  /** The header once every step is done. */
  doneTitle: string;
  steps: readonly string[];
  /** The step in progress (steps before it are done); `steps.length` when all are. */
  at: number;
  /** Quiet text after the title, e.g. the total time: "Researching · 38s". */
  note?: string;
  /** Each step's time, right-aligned on its row ("4s"). */
  times?: readonly (string | undefined)[];
  /** Under a step's row: e.g. the live feed under the step in progress. */
  detail?: (index: number, state: StepState) => ReactNode;
}) {
  const styles = useStyles();
  const c = useTheme();
  const done = at >= steps.length;
  const [open, setOpen] = useState<boolean | null>(null);
  // Open while working, folded when finished, unless you've chosen.
  const expanded = open ?? !done;
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
          {note ? <Text style={styles.note}> · {note}</Text> : null}
        </Text>
        <View style={styles.track}>
          <View
            style={[
              styles.fill,
              { width: `${(Math.min(at, steps.length) / steps.length) * 100}%` },
            ]}
          />
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
            const state: StepState = i < at ? 'done' : i === at ? 'now' : 'next';
            const time = times?.[i];
            const under = detail?.(i, state);
            return (
              <View key={label} style={styles.stepWrap}>
                <View style={styles.step}>
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
                  {time ? <Text style={styles.time}>{time}</Text> : null}
                </View>
                {under ? <View style={styles.under}>{under}</View> : null}
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
  track: { width: 64, height: 6, borderRadius: 3, backgroundColor: c.divider, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: c.success },
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
  stepWrap: { gap: 6 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  // Lined up with the step's label, past its dot.
  under: { paddingLeft: 30 },
  note: { color: c.textSecondary, fontWeight: '400', fontVariant: ['tabular-nums'] },
  time: { color: c.textSecondary, fontSize: 13, fontVariant: ['tabular-nums'] },
  dot: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  dotNum: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  label: { flex: 1, color: c.text, fontSize: 15 },
  muted: { color: c.textSecondary },
}));
