import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { StrategyCard } from '@/components/jars/JarParts';
import { SkeletonBar } from '@/components/motion/Skeleton';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen, SheetText, StatRow } from '@/components/sheets/Sheet';
import { SocialAvatar } from '@/components/social/parts';
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
import { leaveSheetTo } from '@/lib/navigation';
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
    if (answered) leaveSheetTo(`/group/${id}`);
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
      title={`${g.creator.displayName} invited you`}
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
      {/* Who's asking, by face, as a DM request shows it. */}
      <View style={styles.from}>
        <SocialAvatar who={g.creator} size={40} />
        <View style={styles.flex}>
          <SheetText lead>Everyone puts in the same and owns an equal part.</SheetText>
        </View>
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
  from: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  flex: { flex: 1 },
  rows: { marginTop: 16, gap: 2 },
  footer: { gap: 10 },
}));
