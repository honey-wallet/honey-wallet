import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import {
  PerformanceShareCard,
  PerformanceShareCardSkeleton,
  shareCardImage,
} from '@/components/home/PerformanceShareCard';
import { SkeletonReveal } from '@/components/motion/Skeleton';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen } from '@/components/sheets/Sheet';
import { usePnlLine } from '@/components/social/parts';
import { tap } from '@/lib/haptics';
import { isNotFound, loadProfile, useSocial } from '@/lib/social';
import { makeStyles } from '@/theme';

/**
 * Someone's P&L (from a profile's P&L card) as the wallet's share card: their face and
 * @handle, the Honey mark, the return over a week or a month and its line, ready to
 * share as an image. The line is their jars' tokens' prices, ending on their P&L
 * (usePnlLine); the return is from their public jars' marks, which reach back 30 days.
 */
type Range = '1W' | '1M';
const RANGE_DAYS: Record<Range, number> = { '1W': 7, '1M': 30 };

export default function PnlSheet() {
  const { handle: raw } = useLocalSearchParams<{ handle: string }>();
  const handle = (raw ?? '').replace(/^@/, '').toLowerCase();
  const profile = useSocial().profiles[handle];
  // The wallet's share sheet takes its range from where it was opened: here, the
  // profile's "P&L 30D", so a month unless a link asks for a week.
  const { range: asked } = useLocalSearchParams<{ range?: Range }>();
  const range: Range = asked === '1W' ? '1W' : '1M';
  const { pnl, change, line: data } = usePnlLine(profile?.jars, range);
  const [sharing, setSharing] = useState(false);
  const [failed, setFailed] = useState<'missing' | 'error' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const card = useRef<View>(null);
  const haveProfile = !!profile;

  // Opened from a link rather than the profile: fetch them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the Retry trigger.
  useEffect(() => {
    if (haveProfile || !handle) return;
    let live = true;
    setFailed(null);
    void loadProfile(handle).catch((e) => {
      if (live) setFailed(isNotFound(e) ? 'missing' : 'error');
    });
    return () => {
      live = false;
    };
  }, [haveProfile, handle, attempt]);

  if (!profile && (failed || !handle))
    return (
      <SheetScreen title="P&L">
        {failed === 'error' ? (
          <Message
            text="Couldn't load this P&L."
            action="Retry"
            onPress={() => setAttempt((n) => n + 1)}
          />
        ) : (
          <Message
            text={handle ? `@${handle} isn't on Honey.` : 'Nothing here.'}
            action="Back"
            onPress={() => router.back()}
          />
        )}
      </SheetScreen>
    );

  const days = RANGE_DAYS[range];
  const pct = (change ?? 0) * 100;
  const history = pnl?.days.length ?? 0;
  const period = history < days ? 'Since their first jar' : days === 7 ? 'Past week' : 'Past month';

  const share = async () => {
    setSharing(true);
    await shareCardImage(card, `Share @${handle}'s P&L`);
    setSharing(false);
  };

  return (
    <SheetScreen
      footer={
        pnl ? (
          <PillButton label={sharing ? 'Preparing…' : 'Share'} disabled={sharing} onPress={share} />
        ) : undefined
      }
    >
      <SkeletonReveal loading={!profile} skeleton={<PerformanceShareCardSkeleton wide />}>
        {profile ? (
          <PerformanceShareCard
            ref={card}
            name={profile.displayName || profile.handle}
            handle={profile.handle}
            seed={profile.avatarSeed || profile.handle}
            period={period}
            pct={pct}
            data={data}
            locked={pnl ? undefined : 'P&L is private'}
            wide
          />
        ) : null}
      </SkeletonReveal>
    </SheetScreen>
  );
}

/** Not found or failed: one line and the way out. */
function Message({ text, action, onPress }: { text: string; action: string; onPress: () => void }) {
  const styles = useStyles();
  return (
    <View style={styles.message}>
      <Text style={styles.messageText}>{text}</Text>
      <PillButton
        label={action}
        variant="secondary"
        onPress={() => {
          tap();
          onPress();
        }}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  message: { alignItems: 'center', gap: 16, paddingVertical: 24 },
  messageText: { color: c.textSecondary, fontSize: 16, textAlign: 'center' },
}));
