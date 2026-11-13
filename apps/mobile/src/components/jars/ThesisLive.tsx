import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { PickIcon } from '@/components/jars/JarParts';
import { type StepState, StepsCard } from '@/components/jars/StepsCard';
import { Accordion, AccordionChevron } from '@/components/motion/Accordion';
import { PressableScale } from '@/components/motion/PressableScale';
import { TextSwap } from '@/components/motion/TextSwap';
import { tap } from '@/lib/haptics';
import type { Pick } from '@/lib/thesis';
import {
  dripGap,
  elapsed,
  type FeedLine,
  feedFor,
  type LiveProgress,
  type PartialPick,
  revealChars,
  STAGES,
  sharedPrefix,
  stepTime,
} from '@/lib/thesis-live';
import { tokenColor } from '@/lib/token-colors';
import { makeStyles, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

/** Updates shown under the step in progress before "N earlier" folds the rest. */
const WINDOW = 4;
/** The thinking keeps its last few lines in view, older ones fading off the top. */
const THINK_LINES = 6;
const THINK_LINE = 19;

/** The current time, ticking each second while `running`. */
function useNow(running: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return now;
}

/**
 * Text typed out from a buffer at a steady pace (~60 characters a second, faster when
 * it falls behind), so updates that arrive in bursts read as one stream. A rewrite
 * carries on from what the two versions share. `flush` shows it all at once.
 */
function useTypewriter(target: string, flush: boolean) {
  const [shown, setShown] = useState('');
  const current = useRef('');
  useEffect(() => {
    const set = (text: string) => {
      current.current = text;
      setShown(text);
    };
    if (flush) return set(target);
    const kept = current.current.slice(0, sharedPrefix(current.current, target));
    if (kept !== current.current) set(kept);
    if (kept.length >= target.length) return;
    let last = Date.now();
    const t = setInterval(() => {
      const now = Date.now();
      const add = revealChars(target.length - current.current.length, now - last);
      last = now;
      set(target.slice(0, current.current.length + add));
      if (current.current.length >= target.length) clearInterval(t);
    }, 50);
    return () => clearInterval(t);
  }, [target, flush]);
  return shown;
}

/** How many of `count` queued lines to show: one more every ~250ms. */
function useDrip(count: number, flush: boolean) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (flush || shown > count) {
      if (shown !== count) setShown(count);
      return;
    }
    if (shown === count) return;
    const t = setTimeout(() => setShown((n) => Math.min(count, n + 1)), dripGap(count - shown));
    return () => clearTimeout(t);
  }, [count, shown, flush]);
  return Math.min(shown, count);
}

/**
 * The agent at work, as Claude shows it: the steps with their times, and under the one
 * in progress its updates and thinking as they stream in. A finished step folds its
 * thinking into "Thought for 12s", which opens on a tap.
 */
export function ThesisProgress({
  at,
  done,
  live,
}: {
  at: number;
  done: boolean;
  live?: LiveProgress;
}) {
  const now = useNow(!done && !!live);
  const total = live ? (done ? lastEnd(live) : now) - live.startedAt : undefined;
  const times = live
    ? STAGES.map((_, i) => {
        const t = i <= at ? stepTime(live.steps[i], now) : undefined;
        return t === undefined ? undefined : elapsed(t);
      })
    : undefined;
  return (
    <StepsCard
      title="Researching"
      doneTitle="Researched"
      steps={STAGES}
      at={done ? STAGES.length : at}
      note={total !== undefined ? elapsed(total) : undefined}
      times={times}
      detail={
        live
          ? (i: number, state: StepState) =>
              state === 'now' && !done ? (
                <Feed live={live} now={now} />
              ) : state === 'done' ? (
                <Thought live={live} index={i} now={now} />
              ) : null
          : undefined
      }
    />
  );
}

const lastEnd = (live: LiveProgress) =>
  Math.max(live.startedAt, ...live.steps.map((s) => s.end ?? s.start ?? 0));

/** Under the step in progress: its updates one by one, then its thinking, typed out. */
function Feed({ live, now }: { live: LiveProgress; now: number }) {
  const styles = useStyles();
  const lines = feedFor(live, now);
  const shown = useDrip(lines.length, false);
  const visible = lines.slice(0, shown);
  const [all, setAll] = useState(false);
  const window = all ? visible : visible.slice(-WINDOW);
  const earlier = visible.length - window.length;
  const thinking = useTypewriter(live.thoughts[live.at] ?? '', false);
  if (!window.length && !thinking && !all) return null;
  return (
    <Animated.View layout={LinearTransition.duration(DURATION.medium)} style={styles.feed}>
      {earlier > 0 || (all && visible.length > WINDOW) ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityState={{ expanded: all }}
          hitSlop={6}
          scaleTo={0.98}
          onPress={() => {
            tap();
            setAll(!all);
          }}
          style={styles.more}
        >
          <Text style={styles.moreText}>{all ? 'Show less' : `${earlier} earlier`}</Text>
          <AccordionChevron open={all} size={11} color={styles.moreText.color} />
        </PressableScale>
      ) : null}
      <Lines lines={window} />
      {thinking ? <ThinkingTail text={thinking} /> : null}
    </Animated.View>
  );
}

/** Updates, newest at the bottom in the text colour, older ones quieter. */
function Lines({ lines }: { lines: FeedLine[] }) {
  const styles = useStyles();
  return (
    <>
      {lines.map((line, i) => {
        const latest = i === lines.length - 1;
        return (
          <TextSwap
            key={line.id}
            text={line.text}
            style={[
              styles.line,
              latest ? styles.latest : { opacity: 0.55 + (0.45 * (i + 1)) / lines.length },
            ]}
          />
        );
      })}
    </>
  );
}

/** The thinking's last few lines; anything above them fades into the card. */
function ThinkingTail({ text }: { text: string }) {
  const styles = useStyles();
  const c = useTheme();
  const [height, setHeight] = useState(0);
  const max = THINK_LINES * THINK_LINE;
  // Only the tail can show, so only the tail is laid out.
  const tail = text.length > 700 ? `…${text.slice(-700).replace(/^\S*\s/, '')}` : text;
  return (
    <View style={[styles.thinkBox, { maxHeight: max }]}>
      <Text
        onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
        style={styles.thinking}
        accessibilityLiveRegion="polite"
      >
        {tail}
      </Text>
      {height > max ? (
        <Svg pointerEvents="none" style={styles.thinkFade} width="100%" height={THINK_LINE * 2}>
          <Defs>
            <LinearGradient id="thinkFade" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={c.card} stopOpacity={1} />
              <Stop offset="1" stopColor={c.card} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height={THINK_LINE * 2} fill="url(#thinkFade)" />
        </Svg>
      ) : null}
    </View>
  );
}

/** A finished step's thinking, folded into one line that opens on a tap. */
function Thought({ live, index, now }: { live: LiveProgress; index: number; now: number }) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const text = live.thoughts[index];
  const lines = live.events.filter((e) => e.step === index);
  if (!text && !lines.length) return null;
  const took = stepTime(live.steps[index], now);
  const label = text ? `Thought for ${elapsed(took ?? 0)}` : lines.at(-1)?.text;
  return (
    <View>
      <PressableScale
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={6}
        scaleTo={0.98}
        onPress={() => {
          tap();
          setOpen(!open);
        }}
        style={styles.more}
      >
        <Text style={styles.moreText} numberOfLines={1}>
          {label}
        </Text>
        <AccordionChevron open={open} size={11} color={styles.moreText.color} />
      </PressableScale>
      <Accordion open={open}>
        <View style={styles.thoughtBody}>
          {lines.map((line) => (
            <Text key={line.id} style={styles.line}>
              {line.text}
            </Text>
          ))}
          {text ? <Text style={styles.thinking}>{text}</Text> : null}
        </View>
      </Accordion>
    </View>
  );
}

const asPick = (p: PartialPick, i: number): Pick => ({
  symbol: p.symbol,
  name: p.symbol,
  chain: '',
  weight: 0,
  match: 'direct',
  reason: p.reason ?? '',
  color: tokenColor(p.symbol, i),
});

/**
 * The first line of Honey's answer while it still works: the idea as the agent
 * understood it, then each pick's logo as it's chosen.
 */
export function Understood({ theme, picks }: { theme: string; picks: PartialPick[] }) {
  const styles = useStyles();
  return (
    <Animated.View
      entering={FadeIn.duration(DURATION.fast)}
      layout={LinearTransition.duration(DURATION.medium)}
      style={styles.understood}
    >
      <Text style={styles.answerText}>
        <Text style={styles.lead}>Your idea, as I understand it: </Text>
        {theme}
      </Text>
      {picks.length ? (
        <View style={styles.picks}>
          {picks.map((p, i) => (
            <Animated.View
              key={p.symbol}
              entering={FadeIn.duration(DURATION.fast)}
              layout={LinearTransition.duration(DURATION.medium)}
              style={styles.pick}
            >
              <PickIcon pick={asPick(p, i)} size={22} />
              <Text style={styles.pickText}>{p.symbol}</Text>
            </Animated.View>
          ))}
        </View>
      ) : null}
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  feed: { gap: 4 },
  line: { color: c.textSecondary, fontSize: 14, lineHeight: THINK_LINE },
  latest: { color: c.text },
  more: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  moreText: { color: c.textSecondary, fontSize: 13 },
  thinkBox: { overflow: 'hidden', justifyContent: 'flex-end' },
  thinking: { color: c.textSecondary, fontSize: 14, lineHeight: THINK_LINE },
  thinkFade: { position: 'absolute', top: 0, left: 0 },
  thoughtBody: { gap: 4, paddingTop: 4 },
  understood: { gap: 10 },
  answerText: { color: c.text, fontSize: 16, lineHeight: 23 },
  lead: { color: c.textSecondary },
  picks: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  pick: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pickText: { color: c.text, fontSize: 14, fontWeight: '600' },
}));
