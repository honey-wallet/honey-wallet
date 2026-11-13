import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { StrategyCard } from '@/components/jars/JarParts';
import { SkeletonBar } from '@/components/motion/Skeleton';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen, StatRow } from '@/components/sheets/Sheet';
import { PersonByline } from '@/components/social/parts';
import { dollars } from '@/lib/group-jar-core';
import {
  declineGroup,
  groupError,
  groupPicks,
  joinGroup,
  loadGroup,
  sponsorOff,
  useGroup,
} from '@/lib/group-jars';
import { tap } from '@/lib/haptics';
import { SHEET_EXIT } from '@/lib/navigation';
import { showErrorToast, showToast } from '@/lib/toast';
import { makeStyles } from '@/theme';

/**
 * An invite to a group jar, from the bell: the jar, your share, the vote rule and who
 * pays the network fees, then Decline or Join. Joining moves no money; you add your
 * share once the creator has set the group up.
 */
export default function GroupInviteSheet() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const styles = useStyles();
  const g = useGroup(id);
  const feesOff = sponsorOff.useValue();
  const [busy, setBusy] = useState<'join' | 'decline' | null>(null);

  useEffect(() => {
    void loadGroup(id).catch((e) => showErrorToast(groupError(e)));
  }, [id]);

  // Already answered, or the group moved on: its page says where it stands. Declining
  // here just closes the invite.
  const answered =
    !!g && busy !== 'decline' && (g.myState !== 'invited' || g.status !== 'inviting');
  useEffect(() => {
    // All sheets off first (the invite can sit on another sheet), then the group as a
    // full page; pushed into a sheet it opened with a doubled top inset.
    if (!answered) return;
    router.dismissAll();
    setTimeout(() => router.push({ pathname: '/group/[id]', params: { id } }), SHEET_EXIT);
  }, [answered, id]);

  const answer = async (kind: 'join' | 'decline') => {
    if (busy) return;
    tap();
    setBusy(kind);
    try {
      if (kind === 'join') {
        await joinGroup(id);
        showToast('You’re in');
      } else {
        await declineGroup(id);
        router.back();
        // Stays "declining" while the tray closes, so it doesn't open the group instead.
        return;
      }
    } catch (error) {
      showErrorToast(groupError(error));
    }
    setBusy(null);
  };

  if (!g)
    return (
      <SheetScreen title="Group jar">
        <SkeletonBar width="100%" height={132} radius={20} />
        <View style={styles.rows}>
          <SkeletonBar width="100%" height={16} />
          <SkeletonBar width="100%" height={16} />
        </View>
      </SheetScreen>
    );

  return (
    <SheetScreen
      title="You're invited"
      footer={
        <View style={styles.footer}>
          <PillButton
            label="Decline"
            variant="secondary"
            disabled={!!busy}
            onPress={() => void answer('decline')}
          />
          <PillButton
            label={busy === 'join' ? 'Joining…' : 'Join'}
            disabled={!!busy}
            onPress={() => void answer('join')}
          />
        </View>
      }
    >
      {/* Who's asking, as their Feed post would show them. */}
      <View style={styles.from}>
        <PersonByline who={g.creator} at={g.createdAt} />
      </View>
      <StrategyCard split picks={groupPicks(g)} name={g.name} meta={`by @${g.creator.handle}`} />
      <View style={styles.rows}>
        <StatRow label="Your share" value={dollars(g.shareUsd)} />
        <StatRow label="Approvals" value={`${g.threshold} of ${g.people}`} />
        <StatRow label="Network fees" value={feesOff ? '~0.01 NEAR' : 'Paid by Honey'} />
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles(() => ({
  from: { marginBottom: 14 },
  rows: { marginTop: 16, gap: 2 },
  footer: { gap: 10 },
}));
