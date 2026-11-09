import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Keyboard, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { DonutChart } from '@/components/charts/DonutChart';
import { Icon, type IconName } from '@/components/Icon';
import { HoldingRow, People, TokenStack } from '@/components/jars/JarParts';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import {
  AmountCard,
  FieldLabel,
  OptionChips,
  Risk as RiskNote,
  Summary,
} from '@/components/trade/TradeForm';
import { Chip } from '@/components/wallet/Chip';
import { tap } from '@/lib/haptics';
import { type BuyLeg, payJarBuy, quoteJarBuy } from '@/lib/jar-buy';
import { describeRoute, useRoutes } from '@/lib/jar-routes';
import { formatUsd } from '@/lib/mock-wallet';
import { memberName, propose, useActiveMultisig } from '@/lib/multisig';
import { TEST_MODE } from '@/lib/test-mode';
import {
  createThesisJar,
  hostOf,
  linksIn,
  type OrderKind,
  type Proposal,
  RISKS,
  type Risk,
  runThesis,
  STAGES,
  type Visibility,
  withAmount,
  withoutPick,
  withWeight,
} from '@/lib/thesis';
import { chatDraft } from '@/lib/thesis-chat';
import { showToast } from '@/lib/toast';
import { useActiveWallet } from '@/lib/wallets';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

type Step = 'idea' | 'working' | 'proposal' | 'jar';
const AMOUNTS = [100, 500, 1000];
const FEES = [5, 10, 15, 20];
const SLIPPAGES = [0.5, 1, 2];

const VISIBILITY: { id: Visibility; icon: IconName; title: string; hint: string }[] = [
  { id: 'members', icon: 'lock', title: 'Only members', hint: 'Private to you and your friends' },
  {
    id: 'private',
    icon: 'eyeSlash',
    title: 'Returns only',
    hint: 'Others see how it does, not what it holds, and pay to copy',
  },
  {
    id: 'public',
    icon: 'globe',
    title: 'Everyone',
    hint: 'The idea and holdings are public; anyone can copy',
  },
];

/** Friends typed as "a, b c": names, addresses or handles, without repeats. */
const friendList = (text: string) => [
  ...new Set(
    text
      .split(/[,\s]+/)
      .map((f) => f.trim())
      .filter(Boolean),
  ),
];

/** A jar name from the idea: whole words, up to 32 characters. */
function shortName(text: string) {
  if (text.length <= 32) return text;
  const cut = text.slice(0, 33).replace(/[\s,.;:]+\S*$/, '');
  return cut || text.slice(0, 32);
}

/**
 * New jar from an idea: say it any way (words, links), pick an amount and a risk; the
 * agent researches and comes back with tokens you can actually buy. Then name the jar,
 * add friends and choose who sees it.
 */
export default function NewThesisSheet() {
  const styles = useStyles();
  const c = useTheme();
  const { idea, step: openAt } = useLocalSearchParams<{
    idea?: string;
    step?: 'proposal' | 'jar';
  }>();
  // Opened from the chat's Buy or Edit: start on that step with the chat's strategy.
  const fromChat = openAt ? chatDraft.get() : null;
  const [step, setStep] = useState<Step>(fromChat && openAt ? openAt : 'idea');
  const [text, setText] = useState(idea ?? fromChat?.thesis ?? '');
  const [amount, setAmount] = useState('500');
  const [risk, setRisk] = useState<Risk>('Medium');
  const [stage, setStage] = useState(0);
  const [proposal, setProposal] = useState<Proposal | null>(fromChat);
  const [name, setName] = useState(fromChat ? shortName(fromChat.thesis) : '');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [friends, setFriends] = useState('');
  const [copyFee, setCopyFee] = useState(10);
  const [order, setOrder] = useState<OrderKind>('market');
  const [maxSlip, setMaxSlip] = useState(1);
  // Each pick's buy split across chains: live venues when the server answers.
  const { routes, live: liveRoutes } = useRoutes(
    proposal?.picks ?? [],
    proposal?.amount ?? 0,
    maxSlip / 100,
  );
  const links = linksIn(text);
  const value = Number(amount) || 0;

  // Runs the agent; changing the risk on the strategy runs it again at that level.
  const build = async (level: Risk = risk) => {
    tap();
    Keyboard.dismiss();
    setRisk(level);
    const amount = proposal?.amount ?? value;
    setStep('working');
    setStage(0);
    const result = await runThesis({ text, amount, risk: level }, setStage);
    setProposal(result);
    setName(shortName(result.thesis));
    setStep('proposal');
  };

  const [buying, setBuying] = useState(false);
  // A shared wallet buys the jar for its members: the buy is a proposal they approve.
  const multisig = useActiveMultisig();
  const activeWallet = useActiveWallet();
  const create = async () => {
    if (!proposal || buying) return;
    tap();
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
        copyFee: visibility === 'members' ? 0 : copyFee,
        order,
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
      router.replace({ pathname: '/jar/[id]', params: { id } });
      return;
    }
    const options = {
      name: name.trim() || 'My jar',
      visibility,
      friends: friendList(friends),
      copyFee: visibility === 'members' ? 0 : copyFee,
      order,
    };
    // Real buys: on your own, at market, outside test mode. Everything else is saved
    // as a plan (shared and limit buys aren't live yet).
    const real = !TEST_MODE && order === 'market' && !options.friends.length;
    let buy: BuyLeg[] | undefined;
    if (real) {
      setBuying(true);
      try {
        const quoted = await quoteJarBuy(routes, maxSlip / 100);
        buy = await payJarBuy(quoted.legs);
      } catch (error) {
        setBuying(false);
        showToast(error instanceof Error ? error.message : 'Buy failed');
        return;
      }
      setBuying(false);
    }
    const id = createThesisJar(proposal, { ...options, buy });
    showToast(buy ? 'Paid. Swaps are on their way' : 'Jar created');
    router.replace({ pathname: '/jar/[id]', params: { id } });
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

  if (step === 'proposal' && proposal)
    return (
      <SheetScreen
        title="Your strategy"
        size="fill"
        scroll
        onBack={() => (fromChat ? router.back() : setStep('idea'))}
        footer={<PillButton label="Continue" onPress={() => setStep('jar')} />}
      >
        <View style={styles.page}>
          <View style={styles.summary}>
            <DonutChart
              size={72}
              thickness={9}
              segments={proposal.picks.map((p) => ({
                id: p.symbol,
                value: p.weight,
                color: p.color,
              }))}
            >
              <TokenStack picks={proposal.picks} size={18} />
            </DonutChart>
            <View style={styles.flex}>
              <Text style={styles.summaryLabel}>You put in</Text>
              <View style={styles.amountEdit}>
                <Text style={styles.summaryValue}>$</Text>
                <TextInput
                  value={String(proposal.amount)}
                  onChangeText={(t) => {
                    const next = Number(t.replace(/[^\d.]/g, '')) || 0;
                    setProposal(withAmount(proposal, next));
                  }}
                  keyboardType="decimal-pad"
                  selectTextOnFocus
                  accessibilityLabel="Amount in dollars"
                  style={[styles.summaryValue, styles.amountInput]}
                />
                <Icon name="pencil" size={14} color={c.textSecondary} />
              </View>
              <Text style={styles.quote} numberOfLines={2}>
                “{proposal.thesis}”
              </Text>
            </View>
          </View>

          <FieldLabel>Risk</FieldLabel>
          <OptionChips<Risk>
            options={RISKS}
            value={proposal.risk}
            onChange={(next) => void build(next)}
          />
          <Summary
            rows={[
              [
                'Est. slippage',
                `${(
                  (routes.reduce((s, r) => s + r.slippage * r.usd + r.bridgeUsd, 0) /
                    Math.max(proposal.amount, 1)) *
                    100
                ).toFixed(2)}%`,
              ],
              ['Est. fees', formatUsd(proposal.feesUsd)],
              [
                'Fee share',
                `${((proposal.feesUsd / Math.max(proposal.amount, 1)) * 100).toFixed(1)}%`,
              ],
            ]}
          />

          <FieldLabel>{`What it buys${liveRoutes ? '' : ' · sample routes'}`}</FieldLabel>
          <View style={styles.list}>
            {proposal.picks.map((p, i) => {
              // Where this pick gets bought, split across chains for the best fill.
              const route = routes.find((r) => r.symbol === p.symbol);
              return (
                <View key={p.symbol} style={[styles.pickBlock, i > 0 && styles.rule]}>
                  <HoldingRow
                    pick={p}
                    total={proposal.amount}
                    onStep={
                      proposal.picks.length > 1
                        ? (delta) => setProposal(withWeight(proposal, p.symbol, delta))
                        : undefined
                    }
                    onRemove={
                      proposal.picks.length > 1
                        ? () => setProposal(withoutPick(proposal, p.symbol))
                        : undefined
                    }
                  />
                  {p.reason ? <Text style={styles.why}>{p.reason}</Text> : null}
                  {route ? (
                    <Text
                      style={[styles.why, route.status === 'thin' && { color: c.error }]}
                      numberOfLines={2}
                    >
                      {describeRoute(route)}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>

          {proposal.unmatched.length ? (
            <>
              <FieldLabel>Not buyable on chain</FieldLabel>
              <View style={styles.list}>
                {proposal.unmatched.map((u, i) => (
                  <View key={u.idea} style={[styles.pick, i > 0 && styles.rule]}>
                    <Icon name="info" size={18} color={c.textSecondary} />
                    <View style={styles.flex}>
                      <Text style={styles.pickName}>{u.idea}</Text>
                      <Text style={styles.pickReason}>{u.note}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </>
          ) : null}
          <RiskNote text={proposal.caution} />
        </View>
      </SheetScreen>
    );

  if (step === 'jar' && proposal) {
    const people = friendList(friends);
    const share = proposal.amount / (people.length + 1);
    const copyable = visibility !== 'members';
    return (
      <SheetScreen
        title="Launch your jar"
        size="fill"
        scroll
        onBack={() => setStep('proposal')}
        footer={
          <View style={styles.footer}>
            <PillButton
              label={
                buying
                  ? 'Paying…'
                  : multisig
                    ? `Propose to ${activeWallet.label}`
                    : people.length
                      ? `Invite and buy ${formatUsd(share)}`
                      : `Buy ${formatUsd(proposal.amount)} and launch`
              }
              disabled={!name.trim() || buying}
              onPress={() => void create()}
            />
            <Text style={styles.footnote}>You sign every order. Honey never holds your keys.</Text>
          </View>
        }
      >
        <View style={styles.page}>
          <View style={[styles.field, styles.nameField]}>
            <TokenStack picks={proposal.picks} size={26} />
            <TextInput
              value={name}
              onChangeText={setName}
              maxLength={32}
              placeholder="Name your jar"
              placeholderTextColor={c.placeholder}
              style={[styles.input, styles.flex]}
              accessibilityLabel="Jar name"
            />
            <Icon name="pencil" size={14} color={c.textSecondary} />
          </View>

          <FieldLabel>Who's in</FieldLabel>
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
                The shared wallet pays. Members own equal parts, and the buy goes through once{' '}
                {multisig.threshold} of them approve.
              </Text>
            </View>
          ) : (
            <View style={styles.card}>
              <View style={styles.memberRow}>
                <People
                  names={[{ id: 'me', name: 'You' }, ...people.map((n) => ({ id: n, name: n }))]}
                  size={28}
                />
                <Text style={[styles.pickName, styles.flex]}>
                  {people.length
                    ? `You and ${people.length} ${people.length === 1 ? 'friend' : 'friends'}`
                    : 'Just you'}
                </Text>
                {people.length ? (
                  <Text style={styles.pickReason}>{formatUsd(share)} each</Text>
                ) : null}
              </View>
              <View style={[styles.field, styles.inviteField]}>
                <Icon name="person" size={16} color={c.textSecondary} />
                <TextInput
                  value={friends}
                  onChangeText={setFriends}
                  placeholder="Add friends: name.near, 0x…, @handle"
                  placeholderTextColor={c.placeholder}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[styles.input, styles.flex, styles.smallInput]}
                  accessibilityLabel="Friends to invite"
                />
              </View>
              {people.length ? (
                <Text style={styles.pickReason}>
                  Each friend gets an invite to put in their share. Trades need a majority to sign.
                </Text>
              ) : null}
            </View>
          )}

          <FieldLabel>Who can see it</FieldLabel>
          {VISIBILITY.map((v) => (
            <SheetRow
              key={v.id}
              icon={v.icon}
              title={v.title}
              subtitle={v.hint}
              accessory="check"
              selected={visibility === v.id}
              onPress={() => {
                tap();
                setVisibility(v.id);
              }}
            />
          ))}

          {copyable ? (
            <>
              <FieldLabel>Your cut when people copy</FieldLabel>
              <OptionChips
                options={FEES.map(pctLabel)}
                value={pctLabel(copyFee)}
                onChange={(f) => setCopyFee(Number.parseFloat(f))}
              />
              <RiskNote text="Of copiers' profit only, never of a loss. Honey keeps 1.5%." />
            </>
          ) : null}

          <FieldLabel>How to buy</FieldLabel>
          <SheetRow
            icon="clock"
            title="Now"
            subtitle={`At today's price, within ${maxSlip}% slippage, split across chains for the best fill`}
            accessory="check"
            selected={order === 'market'}
            onPress={() => {
              tap();
              setOrder('market');
            }}
          />
          <SheetRow
            icon="target"
            title="At a better price"
            subtitle="Limit order 1% under today's price. Waits up to 24 hours; cancel anytime"
            accessory="check"
            selected={order === 'limit'}
            onPress={() => {
              tap();
              setOrder('limit');
            }}
          />

          <FieldLabel>Max slippage</FieldLabel>
          <OptionChips
            options={SLIPPAGES.map(pctLabel)}
            value={pctLabel(maxSlip)}
            onChange={(sl) => setMaxSlip(Number.parseFloat(sl))}
          />
          <RiskNote
            text={`Launching records that you called this idea on ${new Date().toLocaleDateString(undefined, { dateStyle: 'medium' })}. Your track record starts here.`}
          />
        </View>
      </SheetScreen>
    );
  }

  return (
    <SheetScreen
      title="New idea"
      size="fill"
      footer={
        <PillButton
          label={
            !text.trim() ? 'Describe your idea' : !value ? 'Set an amount' : 'Find what to buy'
          }
          disabled={!text.trim() || !value}
          onPress={() => void build()}
        />
      }
    >
      <View style={styles.page}>
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
              <Chip
                key={url}
                label={hostOf(url)}
                leading={<Icon name="link" size={13} color={c.textSecondary} />}
              />
            ))}
          </View>
        ) : null}

        <AmountCard
          label="Amount"
          unit="USD"
          value={amount}
          onChange={(t) => setAmount(t.replace(/[^\d.]/g, ''))}
        />
        <View style={styles.chips}>
          {AMOUNTS.map((a) => (
            <Chip
              key={a}
              label={`$${a}`}
              accessibilityRole="radio"
              selected={value === a}
              onPress={() => setAmount(String(a))}
            />
          ))}
        </View>

        <FieldLabel>Risk</FieldLabel>
        <OptionChips<Risk> options={RISKS} value={risk} onChange={setRisk} />
      </View>
    </SheetScreen>
  );
}

/** A percentage option's label, "0.5%". */
const pctLabel = (n: number) => `${n}%`;

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  page: { paddingBottom: 16 },
  field: {
    minHeight: 52,
    justifyContent: 'center',
    paddingHorizontal: 14,
    ...radius(16),
    backgroundColor: c.card,
  },
  input: { color: c.text, fontSize: 17 },
  idea: { minHeight: 140, paddingVertical: 12, justifyContent: 'flex-start' },
  ideaInput: { minHeight: 116, textAlignVertical: 'top' },
  chips: { marginTop: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stages: { gap: 18, paddingTop: 12 },
  stage: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pending: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: c.divider },
  stageText: { color: c.text, fontSize: 17 },
  muted: { color: c.textSecondary },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    padding: 16,
    ...radius(20),
    backgroundColor: c.card,
  },
  summaryLabel: { color: c.textSecondary, fontSize: 15 },
  summaryValue: { color: c.text, fontSize: 30, fontWeight: '500', fontVariant: ['tabular-nums'] },
  amountEdit: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  amountInput: { minWidth: 60, padding: 0 },
  quote: { marginTop: 4, color: c.textSecondary, fontSize: 14, lineHeight: 19 },
  footer: { flex: 1, minWidth: 0, gap: 8 },
  footnote: { color: c.textSecondary, fontSize: 13, textAlign: 'center' },
  nameField: { flexDirection: 'row', alignItems: 'center', gap: 12, justifyContent: 'flex-start' },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  inviteField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    justifyContent: 'flex-start',
    minHeight: 44,
    backgroundColor: c.canvas,
  },
  smallInput: { fontSize: 15 },
  // A grey card of rows split by hairlines, as Predict lists a market's answers.
  card: { padding: 16, gap: 12, ...radius(20), backgroundColor: c.card },
  list: { paddingHorizontal: 16, paddingVertical: 4, ...radius(20), backgroundColor: c.card },
  pickBlock: { paddingBottom: 8 },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.divider },
  why: { marginLeft: 48, color: c.textSecondary, fontSize: 13, lineHeight: 18 },
  pick: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  pickName: { color: c.text, fontSize: 16, fontWeight: '600' },
  pickReason: { marginTop: 2, color: c.textSecondary, fontSize: 14, lineHeight: 19 },
}));
