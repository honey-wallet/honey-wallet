import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { StrategyCard } from '@/components/jars/JarParts';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen, StatRow } from '@/components/sheets/Sheet';
import { SuccessPage } from '@/components/sheets/SuccessPage';
import { dollars } from '@/lib/group-jar-core';
import { groupError, groupPicks, payShare, useGroup } from '@/lib/group-jars';
import { success, tap } from '@/lib/haptics';
import { useMyNearUsdc } from '@/lib/jar-dao';
import { showErrorToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

type Stage = 'review' | 'sending' | 'done';

/**
 * Adding your share to a group jar, the way every payment in Honey goes: a review of
 * what leaves your wallet and where it lands, one confirm (Face ID), then a receipt.
 * Opened from the group page's "Add your $X".
 */
export default function GroupPaySheet() {
  const { id = '' } = useLocalSearchParams<{ id?: string }>();
  const g = useGroup(id);
  const styles = useStyles();
  const c = useTheme();
  const [stage, setStage] = useState<Stage>('review');
  const nearUsdc = useMyNearUsdc(!!g);
  if (!g) return null;
  const share = dollars(g.shareUsd);
  const fromNear = nearUsdc !== null && nearUsdc >= g.shareUsd;
  const others = g.people - 1;

  const pay = async () => {
    tap();
    setStage('sending');
    try {
      await payShare(g, nearUsdc);
      success();
      setStage('done');
    } catch (error) {
      setStage('review');
      if (!(error instanceof Error && /cancel/i.test(error.message)))
        showErrorToast(groupError(error));
    }
  };

  if (stage === 'done')
    return (
      <SheetScreen title="" size="fill">
        <SuccessPage
          title="Your share is in"
          detail={
            fromNear
              ? `${g.name} buys once everyone has added theirs.`
              : `It lands in ${g.name} in about a minute. The jar buys once everyone is in.`
          }
          amount={{ symbol: 'USDC', text: `${g.shareUsd} USDC`, usd: share }}
          rows={[
            { label: 'To', value: g.name },
            { label: 'Your share', value: `1 of ${g.people}` },
          ]}
          onDone={() => {
            tap();
            router.back();
          }}
        />
      </SheetScreen>
    );

  return (
    <SheetScreen
      title={`Add your ${share}`}
      size="fill"
      footer={
        <PillButton
          label={stage === 'sending' ? 'Sending…' : `Pay ${share}`}
          disabled={stage === 'sending'}
          onPress={() => void pay()}
        />
      }
    >
      <View style={styles.body}>
        <StrategyCard
          split
          picks={groupPicks(g)}
          name={g.name}
          meta={`Group jar · you and ${others} ${others === 1 ? 'other' : 'others'}`}
        />
        <View>
          <StatRow label="You pay" value={`${share} USDC`} />
          <StatRow label="From" value={fromNear ? 'USDC on NEAR' : 'USDC on Base'} />
          <StatRow label="To" value={`${g.name} (group)`} />
          <StatRow label="Your share" value={`1 of ${g.people}`} />
          <StatRow label="Arrives" value={fromNear ? 'In seconds' : 'In about a minute'} />
        </View>
        {stage === 'sending' ? (
          <View style={styles.sending}>
            <ActivityIndicator size="small" color={c.textSecondary} />
            <Text style={styles.sendingText}>Sending your share…</Text>
          </View>
        ) : null}
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  body: { gap: 20 },
  sending: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sendingText: { color: c.textSecondary, fontSize: 15 },
}));
