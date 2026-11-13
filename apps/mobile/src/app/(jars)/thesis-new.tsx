import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { Avatar } from '@/components/Avatar';
import { Icon, type IconName } from '@/components/Icon';
import { CopyCutSlider } from '@/components/jars/CopyCutSlider';
import { JarAmount } from '@/components/jars/JarAmount';
import { People, PickIcon, StrategyCard, stepSplit } from '@/components/jars/JarParts';
import { PressableScale } from '@/components/motion/PressableScale';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import { PillButton } from '@/components/onboarding/PillButton';
import { KeyboardFooter } from '@/components/sheets/KeyboardFooter';
import { SHEET, SheetScreen, StatRow } from '@/components/sheets/Sheet';
import { AddFace, FACE, FaceRow, FaceTile } from '@/components/social/FaceTile';
import { SocialAvatar, Trend } from '@/components/social/parts';
import { Chip } from '@/components/wallet/Chip';
import { EmptyState } from '@/components/wallet/parts';
import { inviteLabel, MAX_FRIENDS, dollars as plainDollars } from '@/lib/group-jar-core';
import { friendPicks, groupError, startGroup } from '@/lib/group-jars';
import { tap } from '@/lib/haptics';
import { type BuyLeg, payJarBuy, quoteJarBuy } from '@/lib/jar-buy';
import { blockedRoutes, describeRoute, useRoutes } from '@/lib/jar-routes';
import { useBasketChart, useTokenChart } from '@/lib/market';
import { formatUsd } from '@/lib/mock-wallet';
import { memberName, propose, useActiveMultisig } from '@/lib/multisig';
import { SHEET_EXIT } from '@/lib/navigation';
import { jarPayWith } from '@/lib/pay-with';
import { useProfile } from '@/lib/profile';
import { JAR_VISIBILITY, settings, useSettings } from '@/lib/settings';
import { COPY_FEES } from '@/lib/surface';
import { TEST_MODE } from '@/lib/test-mode';
import {
  copyProposal,
  createThesisJar,
  hostOf,
  linksIn,
  manualProposal,
  type OrderKind,
  type Pick,
  PROXIES,
  type Proposal,
  RISKS,
  type Risk,
  runThesis,
  STAGES,
  ThesisError,
  useThesisJars,
  type Visibility,
  withAmount,
  withoutPick,
  withProxy,
} from '@/lib/thesis';
import { chatAsk, chatDraft } from '@/lib/thesis-chat';
import { showErrorToast, showToast } from '@/lib/toast';
import { requireSignIn } from '@/lib/wallet-gate';
import { useActiveWallet } from '@/lib/wallets';
import { Gate, warningOn } from '@/lib/warnings';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

type Step = 'idea' | 'working' | 'proposal' | 'jar';
const AMOUNTS = [100, 500, 1000];
/** "Who can see it" tabs, worded as on the landing page. */
const SEE_TABS: Record<Visibility, string> = {
  members: 'Members',
  private: 'Returns',
  public: 'Everyone',
};

/**
 * New jar from an idea: say it any way (words, links), pick an amount and a risk; the
 * agent researches and comes back with tokens you can actually buy. Then name the jar,
 * add friends and choose who sees it.
 */
export default function NewThesisSheet() {
  const styles = useStyles();
  const profile = useProfile();
  const insets = useSafeAreaInsets();
  const c = useTheme();
  const {
    idea,
    step: openAt,
    copy,
    manual,
    name: named,
    from,
  } = useLocalSearchParams<{
    idea?: string;
    step?: 'proposal' | 'jar';
    /** The jar's name to start with (a group jar's, when its creator invests alone). */
    name?: string;
    /** Copying this jar (its id): the creator's picks and split, at your amount. */
    copy?: string;
    /** Built by hand (jar-build, a post's tokens): chatDraft holds the tokens picked. */
    manual?: string;
    /** Opened from the chat's answer: a change of risk goes back and asks there. */
    from?: string;
  }>();
  // Picks that came from a person, not the agent: changing the risk mustn't re-run it.
  const fixedPicks = !!copy || !!manual;
  const copied = useThesisJars().find((j) => j.id === copy);
  const copiedFrom = copied
    ? { creator: copied.creator, fee: copied.copyFee, jarId: copied.id }
    : undefined;
  // Opened from the chat's Buy or Edit, a copy or your own picks: start on that step with
  // its strategy. A copy opened without its draft (an old link) is built from the jar.
  const [fromChat] = useState(() => {
    if (!openAt) return null;
    const draft = chatDraft.get();
    if (copied) {
      const same =
        draft?.thesis === copied.thesis &&
        draft.picks.map((p) => p.symbol).join() === copied.picks.map((p) => p.symbol).join();
      return same && draft ? draft : copyProposal(copied, settings.get().copyAmount);
    }
    if (copy) return null;
    // Picked tokens arrive at $0: size them now, so test-mode fees scale with the amount.
    if (manual && draft && draft.amount <= 0)
      return {
        ...manualProposal(
          draft.picks,
          settings.get().copyAmount,
          draft.picks.map((p) => p.weight),
        ),
        thesis: draft.thesis,
      };
    return draft;
  });
  const [step, setStep] = useState<Step>(fromChat && openAt ? openAt : 'idea');
  // Every new jar starts paying with USDC; "Pay with" on How much? changes it.
  useEffect(() => jarPayWith.set(null), []);
  const [text, setText] = useState(idea ?? fromChat?.thesis ?? '');
  // Ideas are written in the chat: opened bare (no strategy to review), go there instead;
  // your own jar without its picks (a reload lost them) goes back to picking.
  useEffect(() => {
    if (step !== 'idea' || (copy && !fromChat)) return;
    if (manual) router.replace('/jar-build');
    else router.replace({ pathname: '/thesis-chat', params: idea ? { idea } : {} });
  }, [step, idea, manual, copy, fromChat]);
  const [amount, setAmount] = useState('500');
  const [risk, setRisk] = useState<Risk>(fromChat?.risk ?? 'Medium');
  const [stage, setStage] = useState(0);
  const [proposal, setProposal] = useState<Proposal | null>(fromChat);
  // What goes in, on the "How much?" keypad: the strategy's amount, else Copy's default.
  const [spend, setSpend] = useState(() =>
    fromChat && fromChat.amount > 0 ? fromChat.amount : settings.get().copyAmount,
  );
  // Every jar is named by you on Launch (2026-11-13): the field starts empty under its
  // "Name your jar" placeholder, and the card's title stays blank until you type one.
  const [name, setName] = useState(named ?? '');
  // A copy whose jar loaded after this opened (a cold start from a link): start on it now.
  useEffect(() => {
    if (!copied || proposal || !openAt) return;
    const next = copyProposal(copied, settings.get().copyAmount);
    setProposal(next);
    setSpend(next.amount);
    setText(next.thesis);
    setStep(openAt);
  }, [copied, proposal, openAt]);
  const [visibility, setVisibility] = useState<Visibility>(() => settings.get().jarVisibility);
  // Friends picked in the "Add friends" tray; a fresh launch starts with just you.
  const friends = friendPicks.useValue();
  useEffect(() => {
    friendPicks.set([]);
    return () => friendPicks.set([]);
  }, []);
  // No copy fee is charged yet (lib/surface COPY_FEES), so outside test mode none is set.
  const [copyFee, setCopyFee] = useState(() => (COPY_FEES ? settings.get().jarCopyFee : 0));
  // Limit orders are off for now, so every buy is a market order.
  const [order] = useState<OrderKind>('market');
  // Slippage is automatic here: the max from Settings, changed there, not on Launch.
  const { jarSlippage: maxSlip } = useSettings();
  // Edit split can take a token to 0%: it stays listed (to step back up) but isn't bought,
  // and is left out of the jar on Continue.
  const kept = (proposal?.picks ?? []).filter((p) => p.weight > 0);
  // Each pick's buy split across chains, for the amount on the keypad: live venues when
  // the server answers.
  const { routes, live: liveRoutes } = useRoutes(kept, spend, maxSlip / 100);
  // Real money: every pick must have a payable route before review can go on. In test
  // mode the sample venues are always payable (nothing real is bought).
  const blocked = TEST_MODE ? [] : blockedRoutes(routes);
  const checking = blocked.some((r) => r.status === 'loading');
  // What the order costs on top of the tokens: price impact and pool fees, then bridging.
  const impactUsd = routes.reduce((sum, r) => sum + r.slippage * r.usd, 0);
  const bridgeUsd = routes.reduce((sum, r) => sum + r.bridgeUsd, 0);

  const links = linksIn(text);
  const value = Number(amount) || 0;

  // Runs the agent; changing the risk on the strategy runs it again at that level.
  // Each risk level's answer for this idea, so switching Low / Medium / High swaps the
  // split in place (2026-11-13): the other two are fetched in the background once the
  // first answer is in; one not back yet is fetched then, with the card dimmed meanwhile.
  const byRisk = useRef<Partial<Record<Risk, Proposal>>>({});
  const [reworking, setReworking] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per idea, not per amount or split edit.
  useEffect(() => {
    if (!proposal || fixedPicks || !text.trim()) return;
    byRisk.current[proposal.risk] = proposal;
    // A run that sized every level already has them: no more AI calls.
    for (const level of RISKS) {
      const known = proposal.byRisk?.[level];
      if (known) byRisk.current[level] ??= { ...known, byRisk: proposal.byRisk };
    }
    for (const level of RISKS) {
      if (byRisk.current[level]) continue;
      runThesis({ text, amount: proposal.amount, risk: level }, () => {})
        .then((answer) => {
          byRisk.current[level] ??= answer;
        })
        .catch(() => {});
    }
    // Once per idea: later proposals (an amount, a split) reuse what's cached.
  }, [proposal?.thesis, fixedPicks]);
  const switchRisk = async (level: Risk) => {
    if (!proposal || level === proposal.risk) return;
    tap();
    setRisk(level);
    const cached = byRisk.current[level];
    if (cached) {
      setProposal(withAmount(cached, proposal.amount));
      return;
    }
    setReworking(true);
    try {
      const answer = await runThesis({ text, amount: proposal.amount, risk: level }, () => {});
      byRisk.current[level] = answer;
      setProposal(withAmount(answer, proposal.amount));
    } catch (error) {
      setRisk(proposal.risk);
      showErrorToast(error instanceof ThesisError ? error.message : 'The agent couldn’t finish');
    } finally {
      setReworking(false);
    }
  };

  const build = async (level: Risk = risk) => {
    tap();
    Keyboard.dismiss();
    setRisk(level);
    const amount = proposal ? spend : value;
    setStep('working');
    setStage(0);
    let result: Proposal;
    try {
      result = await runThesis({ text, amount, risk: level }, setStage);
    } catch (error) {
      // Back to the idea with the reason; never an invented proposal.
      setStep(proposal ? 'proposal' : 'idea');
      showErrorToast(error instanceof ThesisError ? error.message : 'The agent couldn’t finish');
      return;
    }
    setProposal(result);
    setStep('proposal');
  };

  // A copy or hand-built jar came through Jars and its amount sheet: close those too, so
  // Back from the new jar returns to Jars, not to a finished amount screen.
  const openJar = (id: string) => {
    if (!fixedPicks) return router.replace({ pathname: '/jar/[id]', params: { id } });
    // Wherever the copy started (Jars, Feed, a profile), close the whole flow (the jar
    // you copied, its amount sheet, this review) and open the new jar on top of the tab
    // you were on: Back from it never lands on a finished keypad. (`dismissTo('/jars')`
    // only replaced this screen when Jars wasn't in the stack.)
    if (router.canDismiss()) router.dismissAll();
    router.push({ pathname: '/jar/[id]', params: { id } });
  };

  const [buying, setBuying] = useState(false);
  // A shared wallet buys the jar for its members: the buy is a proposal they approve.
  const multisig = useActiveMultisig();
  const activeWallet = useActiveWallet();
  const create = async () => {
    if (!proposal || buying) return;
    tap();
    // Never pay (or propose) part of a jar: every pick needs a payable route first.
    if (blocked.length) {
      showErrorToast(`${blocked.map((r) => r.symbol).join(', ')} can’t be bought right now`);
      return;
    }
    if (multisig) {
      const id = `thesis-${Date.now()}`;
      const jarName = name.trim() || 'My jar';
      const { proposal: p, executed } = propose(multisig.walletId, {
        type: 'jarBuy',
        jarId: id,
        jar: jarName,
        picks: proposal.picks.map((x) => x.symbol),
        usd: proposal.amount,
        // A shared jar on NEAR quotes and proposes these live routes.
        legs: routes.flatMap((r) =>
          r.legs
            .filter((l) => l.assetId && l.usd > 0)
            .map((l) => ({ destinationAsset: l.assetId as string, usd: l.usd })),
        ),
      });
      createThesisJar(proposal, {
        id,
        name: jarName,
        visibility,
        friends: [],
        copyFee: copied || visibility !== 'public' ? 0 : copyFee,
        order,
        copiedFrom,
        sharedWallet: {
          walletId: multisig.walletId,
          label: activeWallet.label,
          proposalId: p.id,
          members: multisig.members.map((m) => ({
            id: m.id,
            name: memberName(multisig, m.id),
          })),
        },
      });
      showToast(executed ? 'Jar bought' : 'Proposed. Waiting for approvals');
      openJar(id);
      return;
    }
    // With friends: a group jar. Nothing is bought yet: the group is created and friends
    // are invited; money moves once they've joined (the group's page takes it from here).
    if (friends.length) {
      // Test mode makes a sample group, signed out.
      if (!TEST_MODE && !requireSignIn('invite friends')) return;
      setBuying(true);
      try {
        const group = await startGroup(proposal, {
          name: name.trim() || 'My jar',
          friends,
          visibility,
          copyFee: copied || visibility !== 'public' ? 0 : copyFee,
        });
        showToast(`Invited ${friends.length} ${friends.length === 1 ? 'friend' : 'friends'}`);
        // Off the sheets first, then the group page as a full page: pushed while a sheet
        // is still closing, it opened inside the sheet with a doubled top inset.
        if (router.canDismiss()) router.dismissAll();
        setTimeout(
          () => router.push({ pathname: '/group/[id]', params: { id: group.id } }),
          SHEET_EXIT,
        );
      } catch (error) {
        showErrorToast(groupError(error));
      } finally {
        setBuying(false);
      }
      return;
    }
    const options = {
      name: name.trim() || 'My jar',
      visibility,
      friends: [],
      copyFee: copied || visibility !== 'public' ? 0 : copyFee,
      order,
      copiedFrom,
    };
    // Real buys: on your own, at market, outside test mode. Everything else is saved
    // as a plan (limit buys aren't live yet).
    // A sample strategy (the live agent didn't answer) is never bought with real money.
    const sample = proposal.provenance.sample;
    const real = !TEST_MODE && !sample && order === 'market';
    let buy: BuyLeg[] | undefined;
    let toast =
      sample && !TEST_MODE
        ? 'Saved as a plan. The agent didn’t answer, so nothing was bought'
        : 'Jar created';
    if (real) {
      setBuying(true);
      // Legs already paid, kept even if a later leg fails, so the money stays tracked.
      let sent: BuyLeg[] = [];
      let legCount = 0;
      try {
        const quoted = await quoteJarBuy(routes, maxSlip / 100, {}, jarPayWith.get());
        legCount = quoted.legs.length;
        buy = await payJarBuy(quoted.legs, (legs) => {
          sent = legs.filter((l) => l.txHash);
        });
        toast = 'Paid. Swaps are on their way';
      } catch (error) {
        setBuying(false);
        const text = error instanceof Error ? error.message : 'Buy failed';
        if (!sent.length) {
          showToast(text);
          return;
        }
        // Some swaps went out: save the jar with them instead of losing track (and
        // never re-pay them on a retry).
        buy = sent;
        toast = `Paid ${sent.length} of ${legCount} swaps. ${text}`;
      }
      setBuying(false);
    }
    const id = createThesisJar(proposal, { ...options, buy });
    showToast(toast);
    openJar(id);
    // A jar others can see is a post: once it's bought, ask for the words it leads with
    // (on top of the new jar, after the sheets have closed).
    if (!copied && visibility === 'public')
      setTimeout(() => router.push({ pathname: '/jar-post', params: { id } }), SHEET_EXIT + 250);
  };

  if (step === 'working')
    return (
      <SheetScreen title="Working on it" size="fill">
        <View style={styles.stages}>
          {STAGES.map((label, i) => (
            <Animated.View
              key={label}
              entering={FadeIn.duration(DURATION.fast)}
              style={styles.stage}
            >
              {i < stage ? (
                <Icon name="checkCircle" size={20} color={c.success} />
              ) : i === stage ? (
                <ActivityIndicator size="small" color={c.textSecondary} />
              ) : (
                <View style={styles.pending} />
              )}
              <Text style={[styles.stageText, i > stage && styles.muted]}>{label}</Text>
            </Animated.View>
          ))}
        </View>
      </SheetScreen>
    );

  // The agent found nothing it can buy for this idea: say so plainly, with the two ways
  // forward, instead of an empty arc and a Continue that leads nowhere.
  if (step === 'proposal' && proposal && proposal.picks.length === 0)
    return (
      <SheetScreen
        title="Your strategy"
        size="fill"
        onBack={() => router.back()}
        footer={
          <PillButton
            label="Pick tokens yourself"
            onPress={() => {
              tap();
              router.replace('/jar-build');
            }}
          />
        }
      >
        <EmptyState
          icon="search"
          title="Nothing to buy for this yet"
          hint={
            proposal.unmatched.length
              ? `${proposal.unmatched.map((u) => u.idea).join(', ')} aren't tokens you can buy.`
              : 'Try saying it another way.'
          }
          action={{ label: 'Try another idea', onPress: () => router.back() }}
        />
      </SheetScreen>
    );

  if (step === 'proposal' && proposal) {
    // The split is yours to change unless it's a copy, which keeps the creator's.
    const canEdit = !copied && proposal.picks.length > 1;
    // A pick that can't be bought shows its row under the card, with its fixes.
    const stuck = (symbol: string) =>
      blocked.some((r) => r.symbol === symbol && r.status !== 'loading');
    const rows = kept.filter((p) => stuck(p.symbol));
    return (
      // The one amount screen every jar passes through (an idea, your own picks, a copy):
      // the strategy's card, then the keypad. Back goes to wherever it opened from (the
      // chat, Build your own, a post).
      <SheetScreen title="How much?" size="fill" onBack={() => router.back()}>
        <JarAmount
          header={
            <View style={styles.review}>
              <View style={reworking ? styles.reworking : null}>
                <StrategyCard
                  split
                  jar={copied}
                  picks={proposal.picks}
                  name={copied?.name ?? proposal.thesis}
                  meta={
                    copied
                      ? `by ${copied.creator}${copied.copiers > 0 ? ` · ${copied.copiers} copied` : ''}`
                      : manual
                        ? 'Your jar'
                        : 'Honey’s pick'
                  }
                  fee={
                    COPY_FEES && copied && !copied.mine && copied.copyFee > 0
                      ? `${copied.copyFee}% fee`
                      : undefined
                  }
                  onStep={
                    canEdit
                      ? (symbol, delta) => {
                          const i = proposal.picks.findIndex((p) => p.symbol === symbol);
                          if (i < 0) return;
                          tap();
                          const next = stepSplit(
                            proposal.picks.map((p) => p.weight),
                            i,
                            delta,
                          );
                          setProposal({
                            ...proposal,
                            picks: proposal.picks.map((p, k) => ({ ...p, weight: next[k] ?? 0 })),
                          });
                        }
                      : undefined
                  }
                />
              </View>
              {/* A copy or a hand-built jar keeps its picks: re-running the agent would replace them. */}
              {fixedPicks ? null : (
                <SegmentedTabs<Risk>
                  options={[...RISKS]}
                  labels={{ Low: 'Low risk', Medium: 'Medium', High: 'High risk' }}
                  value={risk}
                  onChange={(next) => {
                    // From the chat: back to it, asking for this risk in the conversation.
                    if (from === 'chat') {
                      tap();
                      chatAsk.set(
                        next === 'Medium'
                          ? 'Make it medium risk'
                          : `Make it ${next.toLowerCase()} risk`,
                      );
                      router.back();
                      return;
                    }
                    void switchRisk(next);
                  }}
                  fill
                />
              )}
              {rows.length ? (
                <View>
                  {rows.map((p) => {
                    const route = routes.find((r) => r.symbol === p.symbol);
                    const proxy = PROXIES[p.symbol];
                    return (
                      <SplitRow
                        key={p.symbol}
                        pick={p}
                        usd={(spend * p.weight) / 100}
                        route={route ? describeRoute(route) : undefined}
                        onRemove={
                          proposal.picks.length > 1
                            ? () => setProposal(withoutPick(proposal, p.symbol))
                            : undefined
                        }
                        proxy={route?.status === 'unbuyable' && proxy ? proxy.symbol : undefined}
                        onProxy={() => setProposal(withProxy(proposal, p.symbol))}
                      />
                    );
                  })}
                </View>
              ) : null}
            </View>
          }
          initial={spend}
          onChange={setSpend}
          hold={
            checking
              ? 'Checking routes…'
              : blocked.length
                ? `Fix ${blocked.map((r) => r.symbol).join(', ')} to continue`
                : undefined
          }
          cta="Continue"
          payWith
          onDone={(amount) => {
            tap();
            // A token stepped down to 0% is left out of the jar.
            setProposal({ ...withAmount(proposal, amount), picks: kept });
            setStep('jar');
          }}
        />
      </SheetScreen>
    );
  }

  if (step === 'jar' && proposal) {
    // Equal shares: the amount on "How much?" is what each person puts in.
    const share = proposal.amount;
    // A copy can't be resold for a cut of someone else's idea, and only Everyone's jars
    // show the picks a copy buys.
    const copyable = COPY_FEES && !copied && visibility === 'public';
    return (
      <SheetScreen
        title="Launch your jar"
        size="fill"
        scroll
        pinFooter
        onBack={() => setStep('proposal')}
        footer={
          <View style={styles.footer}>
            <PillButton
              label={
                buying
                  ? friends.length
                    ? 'Inviting…'
                    : 'Paying…'
                  : multisig
                    ? `Propose to ${activeWallet.label}`
                    : !name.trim()
                      ? 'Name your jar'
                      : friends.length
                        ? inviteLabel(friends.length, share)
                        : `Buy ${formatUsd(proposal.amount)} and launch`
              }
              disabled={!name.trim() || buying || blocked.length > 0}
              onPress={() => void create()}
            />
            <Gate id="jarLaunchKeysNote">
              <Text style={styles.footnote}>
                You sign every order. Honey never holds your keys.
              </Text>
            </Gate>
          </View>
        }
      >
        <View style={styles.gap}>
          {/* The split first, then its name in a field of its own: "Name your jar" is the
              field's own placeholder, so it reads as a box to fill without a heading. */}
          <StrategyCard split picks={proposal.picks} name={name.trim()} />
          <TextInput
            value={name}
            onChangeText={setName}
            autoFocus
            maxLength={32}
            placeholder="Name your jar"
            placeholderTextColor={c.placeholder}
            selectionColor={c.accentText}
            cursorColor={c.accentText}
            returnKeyType="done"
            style={styles.nameField}
            accessibilityLabel="Jar name"
          />

          <Text style={styles.heading}>Who's in</Text>
          {multisig ? (
            <View style={styles.card}>
              <View style={styles.memberRow}>
                <People
                  names={multisig.members.map((m) => ({
                    id: m.id,
                    name: memberName(multisig, m.id),
                  }))}
                  size={28}
                />
                <Text style={[styles.pickName, styles.flex]}>{activeWallet.label}</Text>
                <Text style={styles.pickReason}>
                  {multisig.threshold} of {multisig.members.length} approve
                </Text>
              </View>
              <Text style={styles.pickReason}>
                The shared wallet pays once {multisig.threshold} members approve.
              </Text>
            </View>
          ) : (
            // You, then the friends you add by @handle (up to 4), as big faces in a row
            // with a plus circle to add more. Each puts in the same amount; nobody's in
            // until they accept.
            <View>
              <FaceRow>
                <FaceTile
                  face={
                    <Avatar name="You" size={FACE} uri={profile.photo} seed={profile.avatarSeed} />
                  }
                  label="You"
                />
                {friends.map((f) => (
                  <FaceTile
                    key={f.handle}
                    face={<SocialAvatar who={f} size={FACE} />}
                    label={f.displayName}
                    sublabel={`@${f.handle}`}
                    badge="remove"
                    accessibilityLabel={`Remove @${f.handle}`}
                    onPress={() => friendPicks.set(friends.filter((x) => x.handle !== f.handle))}
                  />
                ))}
                {friends.length < MAX_FRIENDS ? (
                  <FaceTile
                    face={<AddFace />}
                    label="Add"
                    accessibilityLabel="Add friends"
                    onPress={() => router.push('/group-friends')}
                  />
                ) : null}
              </FaceRow>
              {friends.length ? (
                <Text style={styles.pickReason}>
                  You and {friends.length} {friends.length === 1 ? 'friend' : 'friends'} ·{' '}
                  {plainDollars(share)} each
                </Text>
              ) : null}
            </View>
          )}

          <Text style={styles.heading}>Who can see it</Text>
          {/* As on the landing page ("Choose who sees it"): honey tabs, and under them the
              chosen option's badge, name and what it means. */}
          <View style={styles.seePanel}>
            <SegmentedTabs<Visibility>
              honey
              options={JAR_VISIBILITY.map((v) => v.id)}
              labels={SEE_TABS}
              value={visibility}
              onChange={setVisibility}
            />
            {JAR_VISIBILITY.filter((v) => v.id === visibility).map((v) => (
              <Animated.View
                key={v.id}
                entering={FadeIn.duration(DURATION.fast)}
                style={v.id === 'members' ? styles.seeRowOption : styles.seeOption}
              >
                {v.id === 'members' ? (
                  <View style={styles.seeLock}>
                    <Icon name="lock" size={18} color={c.accentText} />
                  </View>
                ) : (
                  <SeePreview id={v.id} picks={proposal.picks} />
                )}
                {/* The tab (and the lock or the picture) already names it: just what it
                    means, beside the lock for Members only. */}
                <Text style={[styles.seeHint, v.id === 'members' && styles.flex]}>{v.hint}</Text>
              </Animated.View>
            ))}
          </View>

          {/* Everyone's jars can be copied: the landing page's cut slider. */}
          {copyable ? <CopyCutSlider value={copyFee} onChange={setCopyFee} /> : null}

          {/* Limit orders ("At a better price") are off for now (2026-11-13): every buy is
              at today's price within the max slippage from Settings.
          <Text style={styles.section}>How to buy</Text>
          <View style={styles.card}>
            <Choice
              first
              icon="clock"
              title="Now"
              hint={`At today's price, within ${maxSlip}% slippage`}
              selected={order === 'market'}
              onPress={() => setOrder('market')}
            />
            <Choice
              icon="target"
              title="At a better price"
              hint="1% under today's price, for up to 24 hours"
              selected={order === 'limit'}
              onPress={() => setOrder('limit')}
            />
          </View> */}
          {/* What it costs on top of the tokens, as review rows. */}
          <View style={styles.rows}>
            {bridgeUsd > 0 ? <StatRow label="Network" value={`≈ ${formatUsd(bridgeUsd)}`} /> : null}
            {/* Real jars learn their fees from each swap's quote, after this step: say so
                instead of a $0.00 that reads as "free". */}
            <StatRow
              label="Fees"
              value={proposal.feesUsd > 0 ? formatUsd(proposal.feesUsd) : 'In each quote'}
            />
            {/* Copying someone's jar: their cut, said once here rather than on the jar. */}
            {COPY_FEES && copied && !copied.mine && copied.copyFee > 0 ? (
              <StatRow
                label="Creator fee"
                value={`${copied.copyFee}% of profit, never of a loss`}
              />
            ) : null}
            {liveRoutes ? null : <StatRow label="Routes" value="Sample" />}
            {warningOn('strategyFeesWarning') &&
            impactUsd + bridgeUsd > proposal.amount * 0.05 &&
            proposal.amount > 0 ? (
              <Text style={styles.warn}>≈ {formatUsd(impactUsd + bridgeUsd)} goes to fees</Text>
            ) : null}
          </View>
          {warningOn('proposalCaution') && proposal.caution ? (
            <Text style={styles.note}>{proposal.caution}</Text>
          ) : null}
        </View>
      </SheetScreen>
    );
  }

  // A copy of a jar that's gone (deleted, or a stale link).
  if (step === 'idea' && copy)
    return (
      <SheetScreen title="Copy jar">
        <Text style={styles.note}>This jar isn’t available any more.</Text>
      </SheetScreen>
    );

  // The chat takes over (above); nothing to draw on the way.
  if (step === 'idea') return null;

  return (
    <SheetScreen
      title="New idea"
      size="fill"
      footer={
        // Pinned to the bottom, where the thumb expects the next step, and lifted above
        // the keyboard the idea field opens at once.
        // Under it already: the sheet's bottom padding over the safe area.
        <KeyboardFooter under={insets.bottom + SHEET.bottom}>
          <PillButton
            label={
              !text.trim() ? 'Describe your idea' : !value ? 'Set an amount' : 'Find what to buy'
            }
            disabled={!text.trim() || !value}
            onPress={() => void build()}
          />
        </KeyboardFooter>
      }
    >
      {/* Tapping anywhere off a field puts the keyboard away. */}
      <Pressable accessible={false} onPress={Keyboard.dismiss} style={[styles.gap, styles.fill]}>
        <View style={[styles.field, styles.idea]}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            autoFocus
            placeholder={'“NS is entering Kazakhstan”\nor paste a link to a post or article'}
            placeholderTextColor={c.placeholder}
            style={[styles.input, styles.ideaInput]}
          />
        </View>
        {links.length ? (
          <View style={styles.chips}>
            {links.map((url) => (
              <View key={url} style={styles.chip}>
                <Icon name="link" size={13} color={c.textSecondary} />
                <Text style={styles.chipText} numberOfLines={1}>
                  {hostOf(url)}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <Text style={styles.section}>Amount</Text>
        <View style={styles.row}>
          <View style={[styles.field, styles.flex]}>
            <TextInput
              value={amount}
              onChangeText={(t) => setAmount(t.replace(/[^\d.]/g, ''))}
              keyboardType="decimal-pad"
              style={styles.input}
              accessibilityLabel="Amount in dollars"
            />
          </View>
          {AMOUNTS.map((a) => (
            <Chip
              key={a}
              accessibilityRole="radio"
              label={`$${a}`}
              selected={value === a}
              onPress={() => setAmount(String(a))}
            />
          ))}
        </View>

        <Text style={styles.section}>Risk</Text>
        <SegmentedTabs<Risk> options={[...RISKS]} value={risk} onChange={setRisk} fill />
      </Pressable>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  reworking: { opacity: 0.5 },
  nameField: {
    height: 52,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.divider,
    backgroundColor: c.card,
    color: c.text,
    fontSize: 17,
    fontWeight: '600',
  },
  flex: { flex: 1 },
  gap: { gap: 12, paddingBottom: 16 },
  fill: { flex: 1 },
  fixRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  section: { marginTop: 8, color: c.textSecondary, fontSize: 15 },
  // Launch's own sections: the grey section label, a step larger than the usual 15pt, bold.
  heading: { marginTop: 12, color: c.textSecondary, fontSize: 17, fontWeight: '700' },
  field: {
    minHeight: 52,
    justifyContent: 'center',
    paddingHorizontal: 14,
    ...radius(14),
    backgroundColor: c.card,
  },
  input: { color: c.text, fontSize: 17 },
  idea: { minHeight: 96, paddingVertical: 12, justifyContent: 'flex-start' },
  ideaInput: { minHeight: 72, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    maxWidth: 200,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    height: 32,
    borderRadius: 16,
    backgroundColor: c.card,
  },
  chipText: { color: c.text, fontSize: 14 },
  stages: { gap: 18, paddingTop: 12 },
  stage: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pending: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: c.divider },
  stageText: { color: c.text, fontSize: 17 },
  muted: { color: c.textSecondary },
  footer: { gap: 8 },
  footnote: { color: c.textSecondary, fontSize: 13, textAlign: 'center' },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  feeRow: { flexDirection: 'row', gap: 8 },
  choiceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  choiceBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.divider },
  choiceIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised,
  },
  choiceIconOn: { backgroundColor: c.accentSurface },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: c.divider,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: c.primary, backgroundColor: c.primary },
  // "Who can see it", as on the landing page: one card holding the honey tabs and, under
  // them, the chosen option (badge, name, one line) on the card itself.
  seePanel: { gap: 16, padding: 16, ...radius(20), backgroundColor: c.card },
  // The chosen option. Members only: the lock with its words beside it. Returns only and
  // Everyone: what other people see (the jar's week as a number and a chart, and for
  // Everyone its coins), then the words.
  seeRowOption: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  seeOption: { gap: 14 },
  seeLock: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentSurface,
  },
  seePreview: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 14 },
  seeCoins: { flexDirection: 'row' },
  seeCoin: { borderRadius: 17, borderWidth: 2, borderColor: c.card },
  seeChart: { flex: 1, height: 48 },
  seeMove: { minWidth: 64 },
  seeMoveEnd: { alignItems: 'flex-end' },
  seePct: { fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  seePeriod: { marginTop: 1, color: c.textSecondary, fontSize: 12 },
  seePctLoading: { width: 56, height: 16, borderRadius: 8, backgroundColor: c.skeleton },
  seeHint: { marginTop: 2, color: c.textSecondary, fontSize: 16, lineHeight: 22 },
  card: { padding: 16, gap: 14, ...radius(20), backgroundColor: c.card },
  pickName: { color: c.text, fontSize: 15, fontWeight: '600' },
  pickReason: { marginTop: 2, color: c.textSecondary, fontSize: 14, lineHeight: 19 },

  // Over the keypad: the strategy's card, its risk and any token to fix.
  review: { gap: 12 },
  rows: { gap: 2 },
  warn: { marginTop: 4, color: c.error, fontSize: 14 },
  note: { color: c.textSecondary, fontSize: 13, lineHeight: 18 },
  splitRow: { paddingVertical: 8 },
  splitMain: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  splitWho: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  splitTrend: { alignSelf: 'flex-start', marginTop: 4 },
  splitShare: { minWidth: 48, alignItems: 'center' },
  splitShareEnd: { alignItems: 'flex-end' },
  splitPct: { color: c.text, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  splitUsd: { color: c.textSecondary, fontSize: 12, fontVariant: ['tabular-nums'] },
  splitDetail: { marginTop: 6, marginLeft: 42, gap: 6 },
  routeText: { color: c.textSecondary, fontSize: 13, lineHeight: 18 },
}));

/** A dollar amount without empty cents: $5, $12.50. */
const dollars = (usd: number) => formatUsd(usd).replace(/\.00$/, '');

/**
 * A token of the split that can't be bought right now: logo and symbol, its week's move
 * in the feed's pill, its dollars and share, then why, and its fixes (a stand-in to use
 * instead, or Remove).
 */
function SplitRow({
  pick,
  usd,
  route,
  onRemove,
  proxy,
  onProxy,
}: {
  pick: Pick;
  usd: number;
  route?: string;
  onRemove?: () => void;
  /** A buyable stand-in to offer when this token can't be bought. */
  proxy?: string;
  onProxy: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const chart = useTokenChart(pick.symbol, '1W');
  const prices = chart.prices;
  const first = prices[0] ?? 0;
  const move =
    prices.length > 2 && first > 0 ? (prices[prices.length - 1] ?? first) / first - 1 : null;
  return (
    <View style={styles.splitRow}>
      <View style={styles.splitMain}>
        <View style={styles.splitWho}>
          <PickIcon pick={pick} size={32} />
          <View style={styles.flex}>
            <Text style={styles.pickName} numberOfLines={1}>
              {pick.symbol}
            </Text>
            {move !== null ? (
              <View style={styles.splitTrend}>
                <Trend value={move} spark={prices} />
              </View>
            ) : null}
          </View>
        </View>
        <View style={[styles.splitShare, styles.splitShareEnd]}>
          <Text style={styles.splitPct}>{dollars(usd)}</Text>
          <Text style={styles.splitUsd}>{pick.weight}%</Text>
        </View>
      </View>
      {route ? (
        <View style={styles.splitDetail}>
          <Text
            style={[styles.routeText, warningOn('routeWarningTint') && { color: c.error }]}
            numberOfLines={2}
          >
            {route}
          </Text>
          {proxy || onRemove ? (
            <View style={styles.fixRow}>
              {proxy ? <Chip variant="filled" label={`Use ${proxy}`} onPress={onProxy} /> : null}
              {onRemove ? <Chip variant="filled" label="Remove" onPress={onRemove} /> : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** One option in a list of choices: icon, title, one line, and a check when picked. */
// biome-ignore lint/correctness/noUnusedVariables: "How to buy" uses it again once limit orders return
function Choice({
  icon,
  title,
  hint,
  selected,
  onPress,
  first,
}: {
  icon: IconName;
  title: string;
  hint: string;
  selected: boolean;
  onPress: () => void;
  first?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableScale
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={[styles.choiceRow, !first && styles.choiceBorder]}
    >
      <View style={[styles.choiceIcon, selected && styles.choiceIconOn]}>
        <Icon name={icon} size={16} color={selected ? c.accentText : c.textSecondary} />
      </View>
      <View style={styles.flex}>
        <Text style={styles.pickName}>{title}</Text>
        <Text style={styles.pickReason}>{hint}</Text>
      </View>
      <View style={[styles.radio, selected && styles.radioOn]}>
        {selected ? <Icon name="check" size={12} color={c.onPrimary} /> : null}
      </View>
    </PressableScale>
  );
}

/**
 * What other people see of the jar: its picks' past week as one number and one chart,
 * weighted by the split, and for Everyone the coins themselves (Returns only keeps them
 * hidden). Both follow the picks as they change.
 */
function SeePreview({ id, picks }: { id: Visibility; picks: Pick[] }) {
  const styles = useStyles();
  const c = useTheme();
  const { series, change, loading } = useBasketChart(picks, '1W');
  const color = change != null && change < 0 ? c.error : c.success;
  const move = (
    <View style={[styles.seeMove, styles.seeMoveEnd]}>
      {change == null ? (
        loading ? (
          <View style={styles.seePctLoading} />
        ) : (
          <Text style={[styles.seePct, { color: c.textSecondary }]}>—</Text>
        )
      ) : (
        <Text style={[styles.seePct, { color }]}>
          {change >= 0 ? '+' : '−'}
          {Math.abs(change * 100).toFixed(1)}%
        </Text>
      )}
      <Text style={styles.seePeriod}>past 7 days</Text>
    </View>
  );
  return (
    <View style={styles.seePreview}>
      {id === 'public' ? (
        <View style={styles.seeCoins}>
          {picks.slice(0, 3).map((p, i) => (
            <View
              key={p.symbol}
              style={[styles.seeCoin, { marginLeft: i ? -10 : 0, zIndex: 3 - i }]}
            >
              <PickIcon pick={p} size={30} />
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.seeChart}>
        <SeeChart series={series} color={color} />
      </View>
      {/* The week's number on the right, for Returns only and Everyone alike. */}
      {move}
    </View>
  );
}

/** A series as a line with a soft fill under it, filling its box; flat while loading. */
function SeeChart({ series, color }: { series: number[]; color: string }) {
  if (series.length < 2) {
    return (
      <Svg width="100%" height="100%" viewBox="0 0 100 40" preserveAspectRatio="none">
        <Path d="M0 30 L100 30" stroke={color} strokeOpacity={0.25} strokeWidth={2} />
      </Svg>
    );
  }
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  const span = hi - lo || 1;
  const points = series.map((v, i) => {
    const x = (i / (series.length - 1)) * 100;
    const y = 36 - ((v - lo) / span) * 32;
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  });
  const line = `M${points.join(' L')}`;
  return (
    <Svg width="100%" height="100%" viewBox="0 0 100 40" preserveAspectRatio="none">
      <Defs>
        <LinearGradient id="seeChartFill" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity={0.22} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Path d={`${line} L100 40 L0 40 Z`} fill="url(#seeChartFill)" />
      <Path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </Svg>
  );
}
