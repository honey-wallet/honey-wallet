import type { SocialGroup, SocialGroupMember } from '@honey-wallet/api-client';
import { router, useLocalSearchParams } from 'expo-router';
import { createElement, type ReactNode, useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { People, StrategyCard } from '@/components/jars/JarParts';
import { SkeletonBar, SkeletonReveal } from '@/components/motion/Skeleton';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetRow, StatRow } from '@/components/sheets/Sheet';
import { SocialAvatar } from '@/components/social/parts';
import { PushedScreen, SCREEN } from '@/components/wallet/parts';
import { backendSession } from '@/lib/backend-session';
import { useFocusPolling } from '@/lib/focus-polling';
import { isDemoGroup } from '@/lib/group-demo';
import {
  dollars,
  type GroupStep,
  groupStatus,
  groupStep,
  memberChip,
  membersIn,
  openProposal,
} from '@/lib/group-jar-core';
import {
  approveVote,
  createGroupOnChain,
  declineGroup,
  goAhead,
  groupError,
  groupPicks,
  groupWallet,
  joinGroup,
  proposeBuy,
  settleShare,
  soloProposal,
  syncGroup,
  upsertGroupJar,
  useGroup,
  usePendingShare,
} from '@/lib/group-jars';
import { tap } from '@/lib/haptics';
import { useDaoJar } from '@/lib/jar-dao';
import { proposalId } from '@/lib/jar-dao-core';
import { blockedRoutes, useRoutes } from '@/lib/jar-routes';
import { hasVoted, useProposal, YOU } from '@/lib/multisig';
import { chatDraft } from '@/lib/thesis-chat';
import { showErrorToast, showToast } from '@/lib/toast';
import { requireSignIn } from '@/lib/wallet-gate';
import { makeStyles, useTheme } from '@/theme';

/** While others are answering, paying or voting, look again this often. */
const POLL_MS = 15_000;

/**
 * A group jar before it's bought (and after it ends): the jar, who's in and where each
 * person stands, and the one thing to do next. Opened from Launch, the bell, or a link
 * (honeywallet://group/<id>, invited handles only). Once bought it becomes the jar's own
 * page, with your slice, votes, Leave and Cash out.
 */
export default function GroupScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const styles = useStyles();
  const c = useTheme();
  const group = useGroup(id);
  // Test mode's sample groups open signed out.
  const signedInAs =
    backendSession.useValue().profile?.wallet.id ?? (isDemoGroup(id) ? 'demo' : null);
  const [failed, setFailed] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!signedInAs) return;
    syncGroup(id)
      .then(() => setFailed(null))
      .catch((e) => setFailed(groupError(e)));
  }, [id, signedInAs]);

  // A link opened signed out: a wallet and a sign-in first, then back here.
  useEffect(() => {
    if (!signedInAs) requireSignIn('open this group jar', `/group/${id}`);
  }, [signedInAs, id]);

  // On every visit, and every 15s while others still have something to do.
  useFocusPolling(refresh, POLL_MS);

  if (!group && failed)
    return (
      <PushedScreen title="" fallback="/jars">
        <View style={styles.message}>
          <Text style={styles.messageText}>{failed}</Text>
          <PillButton
            label="Retry"
            variant="secondary"
            style={styles.messageButton}
            onPress={() => {
              tap();
              refresh();
            }}
          />
        </View>
      </PushedScreen>
    );

  if (!group)
    return (
      <PushedScreen title="" fallback="/jars">
        <SkeletonReveal loading skeleton={<GroupSkeleton />}>
          {null}
        </SkeletonReveal>
      </PushedScreen>
    );
  return <GroupPage group={group} ring={c.canvas} />;
}

function GroupPage({ group: g, ring }: { group: SocialGroup; ring: string }) {
  const styles = useStyles();
  const [walletId, setWalletId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Its DAO, as a quiet shared wallet on this phone, once you're in and it exists.
  useEffect(() => {
    if (g.dao && g.myState === 'accepted') setWalletId(groupWallet(g));
  }, [g]);
  const ledger = useDaoJar(walletId ?? undefined);

  const pending = usePendingShare(g.id);
  const buyVote = openProposal(g, 'buy');
  const chainBuy = useProposal(g.dao && buyVote ? proposalId(g.dao, buyVote.proposalId) : '');
  const step = groupStep(g, {
    paying: !!pending,
    votedOnBuy: !!chainBuy && hasVoted(chainBuy, YOU),
  });

  // Bought: the jar's own page from here on.
  useEffect(() => {
    if (step !== 'active') return;
    const nav = ledger?.navMicro != null ? Number(ledger.navMicro) / 1e6 : null;
    const id = upsertGroupJar(g, nav);
    router.replace({ pathname: '/jar/[id]', params: { id } });
  }, [step, g, ledger?.navMicro]);

  // A Base payment on its way: tell the server once 1Click delivered it.
  useEffect(() => {
    if (!pending) return;
    let live = true;
    const tick = () =>
      settleShare(g.id)
        .then((state) => {
          if (!live) return;
          if (state === 'paid') showToast('Your share is in');
          if (state === 'refunded') showErrorToast('Your payment was refunded. Try again.');
          if (state === 'not_sent') showErrorToast('Your payment didn’t go out. Try again.');
        })
        .catch(() => {});
    void tick();
    const timer = setInterval(tick, 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pending, g.id]);

  const people = membersIn(g);
  const total = g.shareUsd * Math.max(people.length, 1);
  // The buy's live routes, only while it's time to buy.
  const buyable = step === 'buy';
  const usdcUsd = ledger ? Number(ledger.usdcAtomic) / 1e6 : total;
  const { routes } = useRoutes(buyable ? g.picks : [], Math.min(usdcUsd, total), 0.01);
  const blocked = blockedRoutes(routes);

  const act = (label: string, run: () => Promise<unknown>, done?: string) => async () => {
    if (busy) return;
    tap();
    setBusy(label);
    try {
      await run();
      if (done) showToast(done);
    } catch (error) {
      if (!(error instanceof Error && /cancel/i.test(error.message)))
        showErrorToast(groupError(error));
    } finally {
      setBusy(null);
    }
  };

  const joined = people.length - 1;
  const investAlone = act('Invest alone', async () => {
    await goAhead(g.id, true);
    // The normal solo jar: the same picks at your share, on Launch.
    chatDraft.set(soloProposal(g));
    router.push({ pathname: '/thesis-new', params: { step: 'jar', manual: '1', name: g.name } });
  });

  const footer = footerFor(step, {
    busy,
    g,
    joined,
    blocked: blocked.length > 0,
    onJoin: act('Join', () => joinGroup(g.id), 'You’re in'),
    onDecline: act('Decline', () => declineGroup(g.id)),
    onGoAhead: act('Go ahead', () => goAhead(g.id, false)),
    onAlone: investAlone,
    onCreate: act('Create group', () => createGroupOnChain(g), 'Group created'),
    // A review page first, as every payment gets: what leaves, where it lands, then pay.
    onPay: () => {
      tap();
      router.push({ pathname: '/group-pay', params: { id: g.id } });
    },
    onBuy: act(
      'Buy',
      () => proposeBuy(g, routes, ledger?.usdcAtomic ?? 0n),
      'Proposed. Waiting for approvals',
    ),
    onApprove: act(
      'Approve',
      async () => buyVote && (await approveVote(g, buyVote.proposalId)),
      'Approved',
    ),
  });

  // Whoever opened the vote approved it.
  const approvals = chainBuy?.approvals.length ?? (buyVote ? 1 : 0);
  // const status = statusLine(step, g, { joined, approvals });
  const status = groupStatus(step, g, { joined, approvals });

  return (
    <PushedScreen
      title={
        <Text style={styles.headerName} numberOfLines={1}>
          {g.name}
        </Text>
      }
      fallback="/jars"
      // Faces top right: everyone invited or in.
      right={
        <People
          names={g.members
            .filter((m) => m.state === 'invited' || m.state === 'accepted')
            .map((m) => ({ id: m.isMe ? 'me' : m.avatarSeed || m.handle, name: m.displayName }))}
          size={24}
          ring={ring}
        />
      }
      footer={footer}
    >
      <View style={styles.gutter}>
        <StrategyCard
          split
          picks={groupPicks(g)}
          name={g.name}
          meta={`${dollars(g.shareUsd)} each · by @${g.creator.handle}`}
        />
      </View>

      <View style={[styles.section, styles.gutter]}>
        <Text style={styles.heading}>Who's in</Text>
        {g.members.map((m) => (
          <MemberRow key={m.handle} member={m} />
        ))}
      </View>

      <View style={[styles.section, styles.gutter]}>
        <StatRow label="Each puts in" value={dollars(g.shareUsd)} />
        <StatRow label="Approvals" value={`${g.threshold} of ${g.people}`} />
        {status ? <StatRow label="Now" value={status} /> : null}
      </View>
    </PushedScreen>
  );
}

function MemberRow({ member: m }: { member: SocialGroupMember }) {
  const chip = memberChip(m);
  return (
    <SheetRow
      leading={<SocialAvatar who={m} size={40} />}
      title={m.isMe ? 'You' : m.displayName}
      subtitle={`@${m.handle}`}
      value={chip ?? undefined}
    />
  );
}

// Moved to group-jar-core `groupStatus` (14 Nov) so Home's Jars rows say the same.
// /** One short line on where the group stands, when there's something to say. */
// function statusLine(
//   step: GroupStep,
//   g: SocialGroup,
//   n: { joined: number; approvals: number },
// ): string | null {
//   const creator = g.isCreator ? 'you' : g.creator.displayName;
//   const inCount = membersIn(g).length;
//   switch (step) {
//     case 'goAhead':
//       return `${n.joined} of ${g.members.length - 1} joined`;
//     case 'waitInvites':
//       return `Waiting for ${creator}`;
//     case 'waitCreate':
//       return `Waiting for ${creator} to create it`;
//     case 'pay':
//     case 'paying':
//     case 'waitPay':
//       return `${membersIn(g).filter((m) => m.paid).length} of ${inCount} paid`;
//     case 'approve':
//     case 'waitVotes':
//       return `${n.approvals} of ${g.threshold} approved`;
//     case 'closed':
//       return 'Cashed out';
//     case 'solo':
//       return g.isCreator ? 'You invested alone' : `${g.creator.displayName} invested alone`;
//     case 'out':
//       return g.myState === 'declined'
//         ? 'You passed'
//         : g.myState === 'left'
//           ? 'You left'
//           : 'Invite lapsed';
//     default:
//       return null;
//   }
// }

/** The page's buttons for this step: the one honey action at the bottom, grey above it. */
function footerFor(
  step: GroupStep,
  a: {
    busy: string | null;
    g: SocialGroup;
    joined: number;
    blocked: boolean;
    onJoin: () => void;
    onDecline: () => void;
    onGoAhead: () => void;
    onAlone: () => void;
    onCreate: () => void;
    onPay: () => void;
    onBuy: () => void;
    onApprove: () => void;
  },
) {
  const busy = !!a.busy;
  const primary = (label: string, onPress: () => void, disabled = false) => (
    <PillButton
      label={a.busy === label ? `${label}…` : label}
      disabled={busy || disabled}
      onPress={onPress}
    />
  );
  const secondary = (label: string, onPress: () => void) => (
    <PillButton label={label} variant="secondary" disabled={busy} onPress={onPress} />
  );
  const column = (...buttons: ReactNode[]) =>
    createElement(View, { style: still.column }, ...buttons);
  switch (step) {
    case 'join':
      return column(
        <View key="d">{secondary('Decline', a.onDecline)}</View>,
        <View key="j">{primary('Join', a.onJoin)}</View>,
      );
    case 'goAhead':
      return column(
        <View key="a">{secondary('Invest alone', a.onAlone)}</View>,
        <View key="g">
          {primary(
            a.joined > 0 ? `Go ahead with ${a.joined}` : 'Go ahead',
            a.onGoAhead,
            a.joined < 1,
          )}
        </View>,
      );
    case 'create':
      return column(
        <View key="a">{secondary('Invest alone', a.onAlone)}</View>,
        <View key="c">{primary('Create group', a.onCreate)}</View>,
      );
    case 'pay':
      return column(primary(`Add your ${dollars(a.g.shareUsd)}`, a.onPay));
    case 'paying':
      return column(primary('Payment on its way', () => {}, true));
    case 'buy':
      return column(primary('Buy', a.onBuy, a.blocked));
    case 'approve':
      return column(primary('Approve', a.onApprove));
    default:
      return undefined;
  }
}

function GroupSkeleton() {
  const styles = useStyles();
  return (
    <View style={styles.gutter}>
      <SkeletonBar width="100%" height={132} radius={20} />
      <View style={styles.section}>
        <SkeletonBar width={72} height={14} />
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  gutter: { paddingHorizontal: SCREEN.gutter },
  section: { marginTop: 28 },
  // As the Add friends labels: semibold in the text colour, 16 above the people.
  heading: { marginBottom: 16, color: c.text, fontSize: 15, fontWeight: '600' },
  headerName: { color: c.text, fontSize: 16, fontWeight: '500', flexShrink: 1 },
  message: { alignItems: 'center', gap: 16, paddingTop: 96, paddingHorizontal: SCREEN.gutter },
  messageText: { color: c.textSecondary, fontSize: 16, textAlign: 'center' },
  messageButton: { alignSelf: 'center', paddingHorizontal: 28 },
}));

/** The footer's column of buttons (the screen's footer is a row). */
const still = StyleSheet.create({ column: { flex: 1, minWidth: 0, gap: 10 } });
