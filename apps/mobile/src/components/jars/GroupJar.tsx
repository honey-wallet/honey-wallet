import type { SocialGroup } from '@honey-wallet/api-client';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { People } from '@/components/jars/JarParts';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetRow, StatRow } from '@/components/sheets/Sheet';
import { dollars, membersIn } from '@/lib/group-jar-core';
import {
  approveVote,
  cashOutGroup,
  groupError,
  groupWallet,
  leaveGroup,
  syncGroup,
  upsertGroupJar,
  useGroup,
} from '@/lib/group-jars';
import { tap } from '@/lib/haptics';
import { useDaoJar } from '@/lib/jar-dao';
import { proposalId } from '@/lib/jar-dao-core';
import { hasVoted, useMultisigState, YOU } from '@/lib/multisig';
import { showErrorToast, showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

const POLL_MS = 15_000;
const KIND: Record<SocialGroup['proposals'][number]['kind'], string> = {
  buy: 'Buy',
  leave: 'Leave',
  cashout: 'Cash out together',
};

/**
 * A bought group jar, on its jar page: keeps the group and its DAO in sync while the
 * page is open, values the jar at what the DAO holds, and offers its votes, Leave and
 * Cash out. Does nothing for a jar that isn't a group's.
 */
export function useGroupJar(groupId: string | undefined) {
  const g = useGroup(groupId ?? '');
  const [walletId, setWalletId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!groupId) return;
      const tick = () => void syncGroup(groupId).catch(() => {});
      tick();
      const timer = setInterval(tick, POLL_MS);
      return () => clearInterval(timer);
    }, [groupId]),
  );
  useEffect(() => {
    if (g?.dao && g.myState === 'accepted') setWalletId(groupWallet(g));
  }, [g]);
  const ledger = useDaoJar(walletId ?? undefined);
  const nav = ledger?.navMicro != null ? Number(ledger.navMicro) / 1e6 : null;
  // The jar's value is the whole DAO's.
  useEffect(() => {
    if (g && g.status === 'active' && nav !== null) upsertGroupJar(g, nav);
  }, [g, nav]);

  const { proposals } = useMultisigState();
  if (!g) return null;
  const people = membersIn(g);
  const n = Math.max(people.length, 1);
  const total = nav ?? g.shareUsd * n;
  const votes = g.proposals
    .filter((p) => p.status === 'open')
    .map((p) => {
      const chain = g.dao
        ? proposals.find((x) => x.id === proposalId(g.dao as string, p.proposalId))
        : undefined;
      return {
        vote: p,
        approvals: chain?.approvals.length ?? 1,
        voted: chain ? hasVoted(chain, YOU) : true,
      };
    });
  const act = (label: string, run: () => Promise<unknown>, done: string) => async () => {
    if (busy) return;
    tap();
    setBusy(label);
    try {
      await run();
      showToast(done);
    } catch (error) {
      if (!(error instanceof Error && /cancel/i.test(error.message)))
        showErrorToast(groupError(error));
    } finally {
      setBusy(null);
    }
  };
  const toApprove = votes.find((v) => !v.voted);
  return {
    g,
    n,
    slice: total / n,
    votes,
    busy,
    payoutOpen: votes.some((v) => v.vote.kind !== 'buy'),
    approve: toApprove
      ? act('Approve', () => approveVote(g, toApprove.vote.proposalId), 'Approved')
      : null,
    leave: act('Leave', () => leaveGroup(g), 'Proposed. Waiting for approvals'),
    cashOut: act('Cash out', () => cashOutGroup(g), 'Proposed. Waiting for approvals'),
  };
}

export type GroupJarState = NonNullable<ReturnType<typeof useGroupJar>>;

/** The jar page's main action for a group jar: Approve, while a vote waits on you. */
export function GroupJarFooter({ state }: { state: GroupJarState }) {
  if (!state.approve) return null;
  return (
    <PillButton
      label={state.busy === 'Approve' ? 'Approving…' : 'Approve'}
      disabled={!!state.busy}
      onPress={() => void state.approve?.()}
      style={{ flex: 1 }}
    />
  );
}

/**
 * Who's in, your slice (1/N of what the jar holds), open votes, then Leave (your whole
 * slice) and Cash out together. A vote already under way hides both.
 */
export function GroupJarSection({ state }: { state: GroupJarState }) {
  const styles = useStyles();
  const c = useTheme();
  const { g, n, slice, votes } = state;
  const people = membersIn(g);
  const live = g.status === 'active' && g.myState === 'accepted';
  return (
    <View>
      <Text style={styles.heading}>Who's in</Text>
      <View style={styles.who}>
        <People
          names={people.map((m) => ({
            id: m.isMe ? 'me' : m.avatarSeed || m.handle,
            name: m.displayName,
          }))}
          size={28}
          ring={c.canvas}
        />
        <Text style={styles.names} numberOfLines={1}>
          {people.map((m) => (m.isMe ? 'You' : m.displayName.split(' ')[0])).join(', ')}
        </Text>
      </View>
      {live ? (
        <StatRow
          icon={<Icon name="pieOutline" size={15} color={c.textSecondary} />}
          label="Your slice"
          value={`${dollars(slice)} · 1/${n}`}
        />
      ) : (
        <StatRow
          icon={<Icon name="pieOutline" size={15} color={c.textSecondary} />}
          label="Group"
          value={g.status === 'closed' ? 'Cashed out' : 'You left'}
        />
      )}
      {votes.map(({ vote, approvals }) => (
        <SheetRow
          key={vote.proposalId}
          icon="clock"
          title={
            vote.kind === 'leave' ? `${vote.proposer.displayName} is leaving` : KIND[vote.kind]
          }
          subtitle={`${approvals} of ${g.threshold} approved`}
        />
      ))}
      {live && !state.payoutOpen ? (
        <View style={styles.buttons}>
          <PillButton
            label={`Leave with ${dollars(slice)}`}
            variant="secondary"
            disabled={!!state.busy}
            onPress={() => void state.leave()}
          />
          {n > 1 ? (
            <PillButton
              label="Cash out together"
              variant="secondary"
              disabled={!!state.busy}
              onPress={() => void state.cashOut()}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  heading: { marginBottom: 10, color: c.textSecondary, fontSize: 15 },
  who: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  names: { flex: 1, color: c.text, fontSize: 15 },
  buttons: { marginTop: 16, gap: 10 },
}));
