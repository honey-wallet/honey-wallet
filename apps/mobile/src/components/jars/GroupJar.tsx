import type { SocialGroup } from '@honey-wallet/api-client';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { People, PickIcon, SplitRing } from '@/components/jars/JarParts';
import { PressableRow } from '@/components/motion/PressableRow';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetRow, StatRow } from '@/components/sheets/Sheet';
import { useFocusPolling } from '@/lib/focus-polling';
import {
  dollars,
  groupStep,
  membersIn,
  pendingGroupLine,
  pendingGroups,
} from '@/lib/group-jar-core';
import {
  approveVote,
  cashOutGroup,
  groupError,
  groupPicks,
  groups,
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
import { useThesisJars } from '@/lib/thesis';
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

  const sync = useCallback(() => {
    if (groupId) void syncGroup(groupId).catch(() => {});
  }, [groupId]);
  useFocusPolling(sync, POLL_MS, !!groupId);
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
  // Until the DAO's worth arrives, the jar's last value on this phone.
  const lastValue = useThesisJars()
    .find((j) => j.groupId === groupId)
    ?.history.at(-1);
  if (!g) return null;
  const people = membersIn(g);
  const n = Math.max(people.length, 1);
  const total = nav ?? lastValue ?? g.shareUsd * n;
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
 * A group jar's own part of the jar page, the way a bank shows a shared pot: your
 * position first (your slice and share), then open votes, and quiet
 * Manage rows at the end. Leave and Cash out each ask once, inline, before proposing:
 * they're votes that end your stake, so they never sit as big buttons.
 */
export function GroupJarSection({ state }: { state: GroupJarState }) {
  const styles = useStyles();
  const c = useTheme();
  const { g, n, slice, votes } = state;
  const live = g.status === 'active' && g.myState === 'accepted';
  const [confirm, setConfirm] = useState<'leave' | 'cashout' | null>(null);
  const pct = Math.round(100 / n);
  const pie = <Icon name="pieOutline" size={15} color={c.textSecondary} />;
  return (
    <View style={styles.root}>
      <View>
        <Text style={styles.heading}>Your position</Text>
        {live ? (
          <>
            <StatRow icon={pie} label="Your slice" value={dollars(slice)} />
            <StatRow
              icon={<Icon name="personOutline" size={15} color={c.textSecondary} />}
              label="Your share"
              value={`1 of ${n} · ${pct}%`}
            />
            <StatRow
              icon={<Icon name="checkCircle" size={15} color={c.textSecondary} />}
              label="Changes need"
              value={`${g.threshold} of ${n}`}
            />
          </>
        ) : (
          <StatRow
            icon={pie}
            label="Group"
            value={g.status === 'closed' ? 'Cashed out' : 'You left'}
          />
        )}
      </View>

      {votes.length ? (
        <View>
          <Text style={styles.heading}>Open votes</Text>
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
        </View>
      ) : null}

      {live && !state.payoutOpen ? (
        <View>
          <Text style={styles.heading}>Manage</Text>
          {confirm ? (
            <View style={styles.confirm}>
              <Text style={styles.confirmTitle}>
                {confirm === 'leave' ? `Leave with ${dollars(slice)}?` : 'Cash out together?'}
              </Text>
              <Text style={styles.confirmHint}>
                {confirm === 'leave'
                  ? `You get your 1/${n} of each token once ${g.threshold} of ${n} approve.`
                  : `Everyone gets their part and the jar closes once ${g.threshold} of ${n} approve.`}
              </Text>
              <View style={styles.confirmButtons}>
                <PillButton
                  label="Cancel"
                  variant="secondary"
                  size="compact"
                  style={styles.flex}
                  disabled={!!state.busy}
                  onPress={() => {
                    tap();
                    setConfirm(null);
                  }}
                />
                <PillButton
                  label={
                    state.busy
                      ? 'Proposing…'
                      : confirm === 'leave'
                        ? 'Propose leaving'
                        : 'Propose cash out'
                  }
                  variant="secondary"
                  size="compact"
                  style={styles.flex}
                  disabled={!!state.busy}
                  onPress={() =>
                    void (confirm === 'leave' ? state.leave() : state.cashOut()).then(() =>
                      setConfirm(null),
                    )
                  }
                />
              </View>
            </View>
          ) : (
            <>
              {/* Same rows as Your position above, so the page reads as one list. */}
              {n > 1 ? (
                <PressableRow
                  accessibilityRole="button"
                  accessibilityLabel="Cash out together. Close the jar and split it."
                  onPress={() => {
                    tap();
                    setConfirm('cashout');
                  }}
                  style={styles.action}
                >
                  <StatRow
                    icon={<Icon name="arrowDown" size={15} color={c.textSecondary} />}
                    label="Cash out together"
                    value={<Icon name="chevronRight" size={12} color={c.textSecondary} />}
                  />
                </PressableRow>
              ) : null}
              <PressableRow
                accessibilityRole="button"
                accessibilityLabel={`Leave group. Take your ${dollars(slice)} out.`}
                onPress={() => {
                  tap();
                  setConfirm('leave');
                }}
                style={styles.action}
              >
                <StatRow
                  destructive
                  icon={<Icon name="minusCircle" size={15} color={c.error} />}
                  label="Leave group"
                  value={<Text style={styles.actionValue}>{dollars(slice)}</Text>}
                />
              </PressableRow>
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

/** The groups Home's Jars lists before they're bought (lib/group-jar-core `pendingGroups`). */
export const usePendingGroups = () => pendingGroups(Object.values(groups.useValue()));

/**
 * Group jars not bought yet, on Home's Jars above the bought ones, as jar rows: the
 * split, the name, where it stands ("1 of 2 joined", "Ana Lima invited you") and the
 * faces of everyone invited or in. A tap opens the group where you left off; an open
 * invite opens the invite, as the bell does.
 */
export function PendingGroupList({ list, gutter = 18 }: { list: SocialGroup[]; gutter?: number }) {
  return (
    <View>
      {list.map((g) => (
        <PendingGroupRow key={g.id} g={g} gutter={gutter} />
      ))}
    </View>
  );
}

function PendingGroupRow({ g, gutter }: { g: SocialGroup; gutter: number }) {
  const styles = useStyles();
  const c = useTheme();
  const picks = groupPicks(g);
  const top = [...picks].sort((a, b) => b.weight - a.weight)[0];
  const line = pendingGroupLine(g);
  const invite = groupStep(g, { paying: false, votedOnBuy: false }) === 'join';
  return (
    <PressableRow
      accessibilityRole="button"
      accessibilityLabel={`${g.name}, ${line}`}
      onPress={() => {
        tap();
        if (invite) router.push({ pathname: '/group-invite', params: { id: g.id } });
        else router.push({ pathname: '/group/[id]', params: { id: g.id } });
      }}
      style={[styles.row, { marginHorizontal: -gutter, paddingHorizontal: gutter }]}
    >
      {/* The jar's face, as JarIcon draws it. */}
      <SplitRing slices={picks} size={40} stroke={4} tight>
        {top ? <PickIcon pick={top} size={27} /> : null}
      </SplitRing>
      <View style={styles.flex}>
        <Text style={styles.name} numberOfLines={1}>
          {g.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {line}
        </Text>
      </View>
      <People
        names={g.members
          .filter((m) => m.state === 'invited' || m.state === 'accepted')
          .map((m) => ({ id: m.isMe ? 'me' : m.avatarSeed || m.handle, name: m.displayName }))}
        size={24}
        ring={c.canvas}
      />
    </PressableRow>
  );
}

const useStyles = makeStyles((c) => ({
  root: { gap: 28 },
  flex: { flex: 1 },
  heading: { marginBottom: 6, color: c.textSecondary, fontSize: 15 },
  // The press highlight runs edge to edge; the row stays on the page's gutter.
  action: { marginHorizontal: -20, paddingHorizontal: 20 },
  actionValue: { color: c.textSecondary, fontSize: 16 },
  confirm: { gap: 6, paddingVertical: 8 },
  confirmTitle: { color: c.text, fontSize: 17, fontWeight: '600' },
  confirmHint: { color: c.textSecondary, fontSize: 14, lineHeight: 20 },
  confirmButtons: { flexDirection: 'row', gap: 10, marginTop: 10 },
  // As JarRow's (components/jars/JarParts).
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  name: { color: c.text, fontSize: 16, fontWeight: '500' },
  meta: { marginTop: 2, color: c.textSecondary, fontSize: 14 },
}));
