import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Keyboard, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { DonutChart } from '@/components/charts/DonutChart';
import { Icon, type IconName } from '@/components/Icon';
import { Facts, HoldingRow, People, TokenStack } from '@/components/jars/JarParts';
import { PressableScale } from '@/components/motion/PressableScale';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetScreen } from '@/components/sheets/Sheet';
import { tap } from '@/lib/haptics';
import { formatUsd } from '@/lib/mock-wallet';
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
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

type Step = 'idea' | 'working' | 'proposal' | 'jar';
const AMOUNTS = [100, 500, 1000];
const FEES = [5, 10, 15, 20];

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

  const create = () => {
    if (!proposal) return;
    tap();
    const id = createThesisJar(proposal, {
      name: name.trim() || 'My jar',
      visibility,
      friends: friendList(friends),
      copyFee: visibility === 'members' ? 0 : copyFee,
      order,
    });
    showToast('Jar created');
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
        <View style={styles.gap}>
          <View style={styles.summary}>
            <DonutChart
              size={84}
              thickness={10}
              segments={proposal.picks.map((p) => ({
                id: p.symbol,
                value: p.weight,
                color: p.color,
              }))}
            >
              <TokenStack picks={proposal.picks} size={20} />
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
          <SegmentedTabs<Risk>
            options={[...RISKS]}
            labels={{ Low: 'Low risk', Medium: 'Medium', High: 'High risk' }}
            value={proposal.risk}
            onChange={(next) => void build(next)}
            fill
          />
          <Facts
            facts={[
              { label: 'Picks', value: String(proposal.picks.length) },
              { label: 'Est. fees', value: formatUsd(proposal.feesUsd) },
              {
                label: 'Fee share',
                value: `${((proposal.feesUsd / Math.max(proposal.amount, 1)) * 100).toFixed(1)}%`,
              },
            ]}
          />
          <Text style={styles.section}>What it buys</Text>
          <View style={styles.card}>
            {proposal.picks.map((p) => (
              <View key={p.symbol}>
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
                <Text style={styles.why}>{p.reason}</Text>
              </View>
            ))}
          </View>
          {proposal.unmatched.length ? (
            <>
              <Text style={styles.section}>Not buyable on chain</Text>
              <View style={styles.card}>
                {proposal.unmatched.map((u) => (
                  <View key={u.idea} style={styles.pick}>
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
          <View style={[styles.card, styles.row]}>
            <Icon name="warning" size={18} color={c.textSecondary} />
            <Text style={[styles.flex, styles.pickReason]}>{proposal.caution}</Text>
          </View>
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
                people.length
                  ? `Invite and buy ${formatUsd(share)}`
                  : `Buy ${formatUsd(proposal.amount)} and launch`
              }
              disabled={!name.trim()}
              onPress={create}
            />
            <Text style={styles.footnote}>You sign every order. Honey never holds your keys.</Text>
          </View>
        }
      >
        <View style={styles.gap}>
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

          <Text style={styles.section}>Who's in</Text>
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

          <Text style={styles.section}>Who can see it</Text>
          <View style={styles.card}>
            {VISIBILITY.map((v, i) => (
              <Choice
                key={v.id}
                first={i === 0}
                icon={v.icon}
                title={v.title}
                hint={v.hint}
                selected={visibility === v.id}
                onPress={() => setVisibility(v.id)}
              />
            ))}
          </View>

          {copyable ? (
            <>
              <Text style={styles.section}>Your cut when people copy</Text>
              <View style={styles.feeRow}>
                {FEES.map((f) => (
                  <PressableScale
                    key={f}
                    accessibilityRole="button"
                    accessibilityState={{ selected: copyFee === f }}
                    onPress={() => {
                      tap();
                      setCopyFee(f);
                    }}
                    style={[styles.choice, styles.flex, copyFee === f && styles.choiceOn]}
                  >
                    <Text style={styles.choiceText}>{f}%</Text>
                  </PressableScale>
                ))}
              </View>
              <Text style={styles.pickReason}>
                Of copiers' profit only, never of a loss. Honey keeps 1.5%.
              </Text>
            </>
          ) : null}

          <Text style={styles.section}>How to buy</Text>
          <View style={styles.card}>
            <Choice
              first
              icon="clock"
              title="Now"
              hint="At today's price, within 1% slippage"
              selected={order === 'market'}
              onPress={() => setOrder('market')}
            />
            <Choice
              icon="target"
              title="At a better price"
              hint="Limit order 1% under today's price. Waits up to 24 hours; cancel anytime"
              selected={order === 'limit'}
              onPress={() => setOrder('limit')}
            />
          </View>

          <View style={[styles.card, styles.row]}>
            <Icon name="verified" size={18} color={c.accentText} />
            <Text style={[styles.pickReason, styles.flex]}>
              Launching records that you called this idea on{' '}
              {new Date().toLocaleDateString(undefined, { dateStyle: 'medium' })}. Your track record
              starts here.
            </Text>
          </View>
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
      <View style={styles.gap}>
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
            <PressableScale
              key={a}
              accessibilityRole="button"
              accessibilityState={{ selected: value === a }}
              onPress={() => {
                tap();
                setAmount(String(a));
              }}
              style={[styles.choice, value === a && styles.choiceOn]}
            >
              <Text style={styles.choiceText}>${a}</Text>
            </PressableScale>
          ))}
        </View>

        <Text style={styles.section}>Risk</Text>
        <SegmentedTabs<Risk> options={[...RISKS]} value={risk} onChange={setRisk} fill />
      </View>
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  gap: { gap: 12, paddingBottom: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  section: { marginTop: 8, color: c.textSecondary, fontSize: 15 },
  field: {
    minHeight: 52,
    justifyContent: 'center',
    paddingHorizontal: 14,
    ...radius(14),
    backgroundColor: c.card,
  },
  input: { color: c.text, fontSize: 17 },
  idea: { minHeight: 140, paddingVertical: 12, justifyContent: 'flex-start' },
  ideaInput: { minHeight: 116, textAlignVertical: 'top' },
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
  choice: {
    height: 52,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.divider,
  },
  choiceOn: { borderColor: c.text },
  choiceText: { color: c.text, fontSize: 15, fontWeight: '600' },
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
  summaryLabel: { color: c.textSecondary, fontSize: 13 },
  amountEdit: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  amountInput: { minWidth: 60, padding: 0 },
  footer: { gap: 8 },
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
  summaryValue: { color: c.text, fontSize: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  why: {
    marginTop: -4,
    marginBottom: 6,
    marginLeft: 48,
    color: c.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  quote: { marginTop: 4, color: c.textSecondary, fontSize: 14, lineHeight: 19 },
  card: { padding: 16, gap: 14, ...radius(20), backgroundColor: c.card },
  pick: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  pickName: { color: c.text, fontSize: 15, fontWeight: '600' },
  pickReason: { marginTop: 2, color: c.textSecondary, fontSize: 14, lineHeight: 19 },
  pickAmount: { color: c.text, fontSize: 15, fontVariant: ['tabular-nums'] },
  fees: { color: c.textSecondary, fontSize: 13, textAlign: 'center' },
}));

/** One option in a list of choices: icon, title, one line, and a check when picked. */
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
