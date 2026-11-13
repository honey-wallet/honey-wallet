import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  Share,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, LinearGradient, Path, Stop, Text as SvgText } from 'react-native-svg';
import { Icon } from '@/components/Icon';
import { IdeaGrid, PickIcon, StrategyCard } from '@/components/jars/JarParts';
import { ChatChart } from '@/components/jars/ThesisCharts';
import { ThesisProgress, Understood } from '@/components/jars/ThesisLive';
import { HoneyLogo } from '@/components/logo/HoneyLogo';
import { ContentSwap } from '@/components/motion/ContentSwap';
import { PressableScale } from '@/components/motion/PressableScale';
import { SegmentedTabs } from '@/components/motion/SegmentedTabs';
import { PillButton } from '@/components/onboarding/PillButton';
import { SheetRow } from '@/components/sheets/Sheet';
import { CopyStepper } from '@/components/social/parts';
import { HeaderShortcut } from '@/components/wallet/HeaderShortcut';
import { copyText } from '@/lib/copy';
import { tap } from '@/lib/haptics';
import { chartableTokens } from '@/lib/market';
import { goBackOr } from '@/lib/navigation';
import {
  hostOf,
  linksIn,
  type Pick,
  type Proposal,
  RISKS,
  type Risk,
  ThesisError,
  withAmount,
} from '@/lib/thesis';
import {
  type ChatMessage,
  type ChatPart,
  chatAsk,
  chatDraft,
  leftOut,
  money,
  newMessage,
  projection,
  RETRY,
  replay,
  reply,
  SWING,
} from '@/lib/thesis-chat';
import { tokenColor } from '@/lib/token-colors';
import { Gate } from '@/lib/warnings';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

/** The cash the risk rules keep aside, drawn as a USDC row. */
const USDC: Pick = {
  symbol: 'USDC',
  name: 'USD Coin',
  chain: 'Base',
  weight: 0,
  match: 'direct',
  reason: '',
  color: tokenColor('USDC'),
};

/** One line of the message box, and the size of its round buttons. */
const ROW = 36;

/**
 * The idea chat: say what you believe (words or links), the agent researches it and
 * answers with things you can act on: a strategy with Buy (or Propose, in a shared
 * wallet), a projection chart, and quick replies. Ask anything about it after.
 */
export default function ThesisChatScreen() {
  const styles = useStyles();
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const { idea, run, said } = useLocalSearchParams<{
    idea?: string;
    /** A past chat opened from History: its saved answer, read-only. */
    run?: string;
    said?: string;
  }>();
  const readOnly = !!run;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [inputHeight, setInputHeight] = useState(ROW);
  const strategy = useRef<Proposal | null>(null);
  // The message a failed run was answering, for its Try again.
  const retry = useRef<string | null>(null);
  const list = useRef<FlatList<ChatMessage>>(null);

  const send = async (text: string) => {
    const typed = text.trim();
    if (!typed || busy) return;
    // Try again re-asks what failed, not the words "Try again".
    const asked = typed === RETRY && retry.current ? retry.current : typed;
    retry.current = null;
    tap();
    setDraft('');
    setInputHeight(ROW);
    setBusy(true);
    const answer = newMessage('agent', []);
    setMessages((m) => [...m, newMessage('you', [{ type: 'text', text: typed }]), answer]);
    const update = (parts: ChatPart[]) =>
      setMessages((m) => m.map((x) => (x.id === answer.id ? { ...x, parts } : x)));
    try {
      strategy.current = await reply(asked, strategy.current, { update, ...chartableTokens() });
    } catch (error) {
      retry.current = asked;
      update([
        {
          type: 'text',
          text:
            error instanceof ThesisError
              ? error.message
              : "I couldn't finish that. Nothing was bought or signed.",
        },
        { type: 'replies', options: [RETRY] },
      ]);
    } finally {
      setBusy(false);
    }
  };

  // A past chat: the idea as it was asked, then its saved answer (or the run, still going).
  const open = async (runId: string) => {
    setBusy(true);
    const you = newMessage('you', [{ type: 'text', text: said ?? '' }]);
    const answer = newMessage('agent', []);
    setMessages(said ? [you, answer] : [answer]);
    const update = (parts: ChatPart[]) =>
      setMessages((m) => m.map((x) => (x.id === answer.id ? { ...x, parts } : x)));
    try {
      const past = await replay(runId, said ?? '', { update });
      strategy.current = past.proposal;
      if (past.text && past.text !== said)
        setMessages((m) => [
          { ...you, parts: [{ type: 'text', text: past.text }] },
          ...m.filter((x) => x.id !== you.id),
        ]);
    } catch (error) {
      update([
        {
          type: 'text',
          text:
            error instanceof ThesisError ? error.message : "I couldn't open this chat right now.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  };
  // Back from How much? with a change of risk: ask it here, in the conversation.
  useFocusEffect(
    // biome-ignore lint/correctness/useExhaustiveDependencies: reads the latest send
    useCallback(() => {
      const ask = chatAsk.get();
      if (!ask) return;
      chatAsk.set(null);
      void send(ask);
    }, [busy]),
  );

  // An idea passed in (from the Jars field) starts the chat straight away; a past chat
  // opens on its answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useEffect(() => {
    if (run) void open(run);
    else if (idea) void send(idea);
  }, []);

  const empty = messages.length === 0;
  // Only the newest strategy can be bought; older ones say they were updated.
  const latestStrategy =
    [...messages].reverse().find((m) => m.parts.some((p) => p.type === 'strategy'))?.id ?? null;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.screen, { paddingTop: insets.top }]}
    >
      <View style={styles.top}>
        <HeaderShortcut icon="chevronLeft" label="Back" onPress={() => goBackOr('/jars')} />
        <View style={styles.titleWrap}>
          <Text style={styles.title}>Thesis agent</Text>
        </View>
        {readOnly ? (
          <View style={styles.topSpacer} />
        ) : (
          <HeaderShortcut
            icon="history"
            label="History"
            onPress={() => router.push('/thesis-history')}
          />
        )}
      </View>

      {empty ? (
        <ScrollView
          style={styles.flexFill}
          contentContainerStyle={styles.welcome}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <View style={styles.welcomeIcon}>
            <HoneyLogo variant="mark" height={72} />
          </View>
          <Text style={styles.welcomeTitle}>What do you believe in?</Text>
          <Text style={styles.welcomeHint}>
            Say it any way, or paste a post. Honey finds what you can buy.
          </Text>
          {/* The Jars page's idea cards, each starting the conversation with its idea. */}
          <View style={styles.starters}>
            <IdeaGrid onPick={(title) => void send(title)} />
          </View>
        </ScrollView>
      ) : (
        <FlatList
          ref={list}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.thread}
          // Buttons in answers work with the keyboard up; dragging the thread lowers it.
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
          renderItem={({ item, index }) => (
            <Message
              message={item}
              onSay={(t) => void send(t)}
              busy={busy}
              last={index === messages.length - 1}
              latestStrategy={latestStrategy}
              onVariant={(p) => {
                strategy.current = p;
              }}
            />
          )}
        />
      )}

      {readOnly ? (
        <View style={{ height: Math.max(insets.bottom, 12) }} />
      ) : (
        <View style={[styles.composerWrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          {linksIn(draft).length ? (
            <View style={styles.linkRow}>
              {linksIn(draft).map((url) => (
                <View key={url} style={styles.link}>
                  <Icon name="link" size={12} color={c.textSecondary} />
                  <Text style={styles.linkText} numberOfLines={1}>
                    {hostOf(url)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          <View style={styles.composer}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Paste a link"
              hitSlop={6}
              onPress={() => {
                tap();
                setDraft((d) => (d.endsWith(' ') || !d ? `${d}https://` : `${d} https://`));
              }}
              style={styles.attach}
            >
              <Icon name="paperclip" size={18} color={c.textSecondary} />
            </PressableScale>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={empty ? 'An idea, or a link to a post' : 'Ask anything about it'}
              placeholderTextColor={c.placeholder}
              multiline
              numberOfLines={1}
              autoFocus={!idea}
              // One line to start (a web textarea defaults to two), growing to five.
              onContentSizeChange={(e) =>
                setInputHeight(
                  Math.min(120, Math.max(ROW, Math.ceil(e.nativeEvent.contentSize.height))),
                )
              }
              style={[styles.input, { height: inputHeight }]}
              // Enter sends, Shift+Enter adds a line (web and hardware keyboards).
              onKeyPress={(e) => {
                const key = e.nativeEvent as unknown as { key: string; shiftKey?: boolean };
                if (key.key === 'Enter' && !key.shiftKey) {
                  (e as unknown as { preventDefault?: () => void }).preventDefault?.();
                  void send(draft);
                }
              }}
              onSubmitEditing={() => void send(draft)}
              submitBehavior="submit"
              accessibilityLabel="Message"
            />
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Send"
              accessibilityState={{ disabled: !draft.trim() || busy }}
              disabled={!draft.trim() || busy}
              onPress={() => void send(draft)}
              style={[styles.send, (!draft.trim() || busy) && styles.sendOff]}
            >
              {busy ? (
                <ActivityIndicator size="small" color={c.onPrimary} />
              ) : (
                <Icon
                  name="arrowUp"
                  size={18}
                  color={!draft.trim() ? c.textSecondary : c.onPrimary}
                />
              )}
            </PressableScale>
          </View>
          <Gate id="assistantDisclaimer">
            <Text style={styles.disclaimer}>
              Honey can be wrong. You review and sign every order.
            </Text>
          </Gate>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

function Message({
  message,
  onSay,
  busy,
  last,
  latestStrategy,
  onVariant,
}: {
  message: ChatMessage;
  onSay: (text: string) => void;
  busy: boolean;
  last: boolean;
  latestStrategy: string | null;
  onVariant: (proposal: Proposal) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const [rated, setRated] = useState<'up' | 'down' | null>(null);
  if (message.from === 'you')
    return (
      <View style={styles.youRow}>
        <View style={styles.you}>
          <Text style={styles.youText}>
            {message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}
          </Text>
        </View>
      </View>
    );
  const text = message.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n\n');
  const working = busy && last;
  return (
    <Animated.View entering={FadeIn.duration(DURATION.fast)} style={styles.agent}>
      {/* LibreChat's assistant turn: a small avatar and name, then the answer, full width. */}
      <View style={styles.agentHead}>
        <View style={styles.agentAvatar}>
          <Icon name="jar" size={14} color={c.onPrimary} />
        </View>
        <Text style={styles.agentName}>Honey</Text>
      </View>
      <View style={styles.agentBody}>
        {message.parts.length === 0 ? <Typing /> : null}
        {message.parts.map((part, i) => (
          <Part
            // Keyed by kind, so a part keeps its state (the live feed's buffers) when
            // another arrives before it (the idea, once understood).
            key={partKey(message.parts, i)}
            part={part}
            onSay={onSay}
            busy={busy}
            stream={last}
            latest={latestStrategy === message.id}
            onVariant={onVariant}
          />
        ))}
        {!working && text ? (
          <View style={styles.actions}>
            <Action icon="copy" label="Copy" onPress={() => void copyText(text, 'Copied')} />
            <Action
              icon="thumbsUp"
              label="Good answer"
              active={rated === 'up'}
              onPress={() => setRated(rated === 'up' ? null : 'up')}
            />
            <Action
              icon="thumbsDown"
              label="Bad answer"
              active={rated === 'down'}
              onPress={() => setRated(rated === 'down' ? null : 'down')}
            />
            <Action
              icon="share"
              label="Share"
              onPress={() => void Share.share({ message: text }).catch(() => {})}
            />
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}

function Action({
  icon,
  label,
  onPress,
  active,
}: {
  icon: 'copy' | 'thumbsUp' | 'thumbsDown' | 'share';
  label: string;
  onPress: () => void;
  active?: boolean;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      hitSlop={6}
      scaleTo={0.9}
      onPress={() => {
        tap();
        onPress();
      }}
      style={styles.action}
    >
      <Icon name={icon} size={15} color={active ? c.text : c.textSecondary} />
    </PressableScale>
  );
}

/** "stages-0", "text-1": a part's kind and its count among that kind. */
const partKey = (parts: ChatPart[], i: number) => {
  const type = parts[i]?.type;
  return `${type}-${parts.slice(0, i).filter((p) => p.type === type).length}`;
};

/** Three dots while the agent starts thinking. */
function Typing() {
  const styles = useStyles();
  const [n, setN] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setN((x) => (x % 3) + 1), 350);
    return () => clearInterval(t);
  }, []);
  return (
    <Text style={styles.muted} accessibilityLabel="Honey is thinking">
      Thinking{'.'.repeat(n)}
    </Text>
  );
}

/** Text that types itself out the first time it shows, like a streamed answer. */
function StreamText({ text, stream }: { text: string; stream: boolean }) {
  const styles = useStyles();
  const words = text.split(/(\s+)/);
  const [shown, setShown] = useState(stream ? 0 : words.length);
  useEffect(() => {
    if (shown >= words.length) return;
    const t = setTimeout(() => setShown((n) => Math.min(words.length, n + 3)), 24);
    return () => clearTimeout(t);
  }, [shown, words.length]);
  return <Text style={styles.agentText}>{words.slice(0, shown).join('')}</Text>;
}

function Part({
  part,
  onSay,
  busy,
  stream,
  latest,
  onVariant,
}: {
  part: ChatPart;
  onSay: (t: string) => void;
  busy: boolean;
  stream: boolean;
  latest: boolean;
  onVariant: (proposal: Proposal) => void;
}) {
  const styles = useStyles();
  switch (part.type) {
    case 'text':
      return <StreamText text={part.text} stream={stream} />;
    case 'understood':
      return <Understood theme={part.theme} picks={part.picks} />;
    case 'stages':
      // The steps with their times and live feed: open while it works, folded once done.
      return <ThesisProgress at={part.at} done={part.done} live={part.live} />;
    case 'strategy':
      return <AnswerCard proposal={part.proposal} latest={latest} onVariant={onVariant} />;
    case 'projection':
      return <ProjectionCard amount={part.amount} risk={part.risk} />;
    case 'chart':
      return <ChatChart symbols={part.symbols} range={part.range} picks={part.picks} />;
    case 'replies':
      return (
        <View style={styles.replies}>
          {part.options.map((o) => (
            <PressableScale
              key={o}
              accessibilityRole="button"
              disabled={busy}
              scaleTo={0.96}
              onPress={() => onSay(o)}
              style={styles.reply}
            >
              <Text style={styles.replyText}>{o}</Text>
            </PressableScale>
          ))}
        </View>
      );
  }
}

/**
 * The answer you act on (2026-11-13): the Feed's strategy card (coins, name, split), a
 * Low / Medium / High switch when the run sized all three (swapped in place, no new AI
 * call), why each pick, what was left out, what could go wrong, and one Create jar to
 * "How much?", where the amount is set. Nothing it can buy: say so, with the way to pick
 * tokens yourself.
 */
function AnswerCard({
  proposal,
  latest,
  onVariant,
}: {
  proposal: Proposal;
  latest: boolean;
  onVariant: (proposal: Proposal) => void;
}) {
  const styles = useStyles();
  const levels = RISKS.filter((r) => proposal.byRisk?.[r]);
  const [level, setLevel] = useState<Risk>(proposal.risk);
  const variant = (r: Risk): Proposal =>
    r === proposal.risk || !proposal.byRisk?.[r]
      ? proposal
      : { ...withAmount(proposal.byRisk[r] as Proposal, proposal.amount), byRisk: proposal.byRisk };
  const shown = variant(level);
  const cash = shown.cashPct && shown.cashPct > 0 ? shown.cashPct : 0;
  const left = leftOut(shown.unmatched);
  const riskSwitch =
    levels.length > 1 ? (
      <SegmentedTabs<Risk>
        options={levels}
        labels={{ Low: 'Low risk', Medium: 'Medium', High: 'High risk' }}
        value={level}
        onChange={(next) => {
          setLevel(next);
          if (latest) onVariant(variant(next));
        }}
        fill
      />
    ) : null;
  const leftOutBlock = left.length ? (
    <View>
      <Text style={styles.sectionLabel}>Left out</Text>
      <View style={styles.list}>
        {left.map((u) => (
          <View key={u.idea}>
            <Text style={styles.leftOut}>{u.idea}</Text>
            {u.note ? <Text style={styles.footnote}>{u.note}</Text> : null}
          </View>
        ))}
      </View>
    </View>
  ) : null;
  if (!shown.picks.length)
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Nothing to buy for this yet</Text>
        {riskSwitch}
        {leftOutBlock}
        {latest ? (
          <PillButton
            label="Pick tokens yourself"
            variant="secondary"
            onPress={() => {
              tap();
              router.push('/jar-build');
            }}
          />
        ) : null}
      </View>
    );
  return (
    // A Feed post's strategy well: coins, name, the striped split, then − Buy 5 [USDC] +.
    <StrategyCard
      picks={shown.picks}
      name={shown.thesis}
      meta={`${shown.risk} risk · ${shown.picks.length} ${
        shown.picks.length === 1 ? 'token' : 'tokens'
      }`}
      split
    >
      {riskSwitch}
      {/* Why each pick, as the app's rows: its logo, the token, the agent's reason (and
          what would prove it wrong), its share; then what the risk rules kept in USDC.
          A new risk level slides its rows in from the side it sits on. */}
      {shown.picks.some((p) => p.reason) || cash ? (
        <ContentSwap id={level} index={RISKS.indexOf(level)}>
          <Text style={styles.sectionLabel}>Why these</Text>
          {shown.picks.map((p) => (
            <SheetRow
              key={`${p.symbol}-${p.chain}`}
              leading={<PickIcon pick={p} size={32} />}
              title={p.symbol}
              subtitle={
                p.wrongIf ? (
                  <View style={styles.flex}>
                    {p.reason ? <Text style={styles.rowReason}>{p.reason}</Text> : null}
                    <Text style={styles.footnote}>{p.wrongIf}</Text>
                  </View>
                ) : (
                  p.reason
                )
              }
              value={`${p.weight}%`}
            />
          ))}
          {cash ? (
            <SheetRow
              leading={<PickIcon pick={USDC} size={32} />}
              title="Kept in USDC"
              value={`${cash}%`}
            />
          ) : null}
        </ContentSwap>
      ) : null}
      {leftOutBlock}
      {shown.bearCase?.length ? (
        <View>
          <Text style={styles.sectionLabel}>What could go wrong</Text>
          <View style={styles.list}>
            {shown.bearCase.map((line) => (
              <View key={line} style={styles.listItem}>
                <Text style={styles.listText}>•</Text>
                <Text style={[styles.listText, styles.flex]}>{line}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
      {latest ? (
        <Text style={styles.footnote}>
          Crypto is unregulated and can be highly risky. Only invest what you're prepared to lose.
        </Text>
      ) : null}
      {latest ? (
        <CopyStepper
          primary
          verb="Create jar"
          label="Create jar"
          onCopy={(amount) => {
            tap();
            // The level on screen is the one bought.
            chatDraft.set(withAmount(shown, amount));
            router.push({ pathname: '/thesis-new', params: { step: 'proposal', from: 'chat' } });
          }}
        />
      ) : (
        <Text style={styles.muted}>Updated below.</Text>
      )}
    </StrategyCard>
  );
}

/** Where this answer's numbers came from: prices and their time, and what was read. */
// biome-ignore lint/correctness/noUnusedVariables: kept while Sources is switched off.
function Sources({ proposal }: { proposal: Proposal }) {
  const styles = useStyles();
  const c = useTheme();
  const { provenance, sources } = proposal;
  const time = new Date(provenance.at).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <View style={styles.sources}>
      <Text style={styles.sourcesLabel}>Sources</Text>
      <View style={styles.sourceRow}>
        <View style={[styles.source, provenance.sample && styles.sourceSample]}>
          <Icon name={provenance.sample ? 'info' : 'clock'} size={12} color={c.textSecondary} />
          <Text style={styles.sourceText}>
            {provenance.prices} · {time}
          </Text>
        </View>
        {sources.map((src) => (
          <PressableScale
            key={src.url}
            accessibilityRole="link"
            accessibilityLabel={`Open ${src.title}`}
            onPress={() => void Linking.openURL(src.url).catch(() => {})}
            style={styles.source}
          >
            <Icon name="link" size={12} color={c.textSecondary} />
            <Text style={styles.sourceText} numberOfLines={1}>
              {src.title}
            </Text>
          </PressableScale>
        ))}
      </View>
    </View>
  );
}

/** A rough 12-month range: the band between a bad and a good year, the middle line. */
function ProjectionCard({ amount, risk }: { amount: number; risk: Risk }) {
  const styles = useStyles();
  const c = useTheme();
  const [width, setWidth] = useState(0);
  const { low, mid, high } = projection(amount, risk);
  const H = 156;
  // Room at the right for each outcome's number, at the end of its line.
  const LABELS = 60;
  const max = Math.max(...high);
  const min = Math.min(...low);
  const plot = Math.max(width - LABELS, 1);
  const x = (i: number) => (i / (mid.length - 1)) * (plot - 8) + 4;
  const y = (v: number) => 12 + (1 - (v - min) / Math.max(max - min, 1)) * (H - 36);
  const line = (vs: number[]) => vs.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
  const band = `${line(high)}${[...low]
    .reverse()
    .map((v, i) => `L${x(low.length - 1 - i)},${y(v)}`)
    .join('')}Z`;
  const end = (vs: number[]) => Math.round(vs.at(-1) ?? 0);
  const ends = [
    { v: end(high), color: c.success, word: 'Good' },
    { v: end(mid), color: c.text, word: 'Likely' },
    { v: end(low), color: c.error, word: 'Bad' },
  ];
  return (
    <View style={styles.card}>
      {/* The likely outcome leads; the range sits under it, as a price and its move. */}
      <Text style={styles.muted}>{money(amount)} in 12 months, likely</Text>
      <Text style={styles.cardValue}>{money(end(mid))}</Text>
      <Text style={styles.muted}>
        Between {money(end(low))} and {money(end(high))}
      </Text>
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={styles.projChart}>
        {width > 0 ? (
          <Svg width={width} height={H}>
            <Defs>
              <LinearGradient id="projBand" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={c.success} stopOpacity={0.22} />
                <Stop offset="0.5" stopColor={c.text} stopOpacity={0.05} />
                <Stop offset="1" stopColor={c.error} stopOpacity={0.18} />
              </LinearGradient>
            </Defs>
            <Path d={band} fill="url(#projBand)" />
            <Path d={line(high)} stroke={c.success} strokeWidth={1.5} fill="none" opacity={0.8} />
            <Path d={line(low)} stroke={c.error} strokeWidth={1.5} fill="none" opacity={0.8} />
            <Path d={line(mid)} stroke={c.primary} strokeWidth={2.5} fill="none" />
            {ends.map((e, i) => {
              const vs = i === 0 ? high : i === 1 ? mid : low;
              const cy = y(vs.at(-1) ?? 0);
              return (
                <Circle
                  key={e.word}
                  cx={x(vs.length - 1)}
                  cy={cy}
                  r={3.5}
                  fill={i === 1 ? c.primary : e.color}
                />
              );
            })}
            {ends.map((e, i) => {
              const vs = i === 0 ? high : i === 1 ? mid : low;
              // Keep the three numbers apart even when the band is narrow.
              const raw = y(vs.at(-1) ?? 0);
              const cy =
                i === 0
                  ? Math.min(raw, y(mid.at(-1) ?? 0) - 18)
                  : i === 2
                    ? Math.max(raw, y(mid.at(-1) ?? 0) + 18)
                    : raw;
              return (
                <SvgText
                  key={`t${e.word}`}
                  x={plot + 6}
                  y={cy + 4}
                  fill={e.color}
                  fontSize={13}
                  fontWeight="600"
                  fontFamily="system-ui, -apple-system, sans-serif"
                >
                  {money(e.v)}
                </SvgText>
              );
            })}
            <SvgText
              x={4}
              y={H - 4}
              fill={c.textSecondary}
              fontSize={11}
              fontFamily="system-ui, -apple-system, sans-serif"
            >
              Today
            </SvgText>
            <SvgText
              x={plot - 4}
              y={H - 4}
              fill={c.textSecondary}
              fontSize={11}
              fontFamily="system-ui, -apple-system, sans-serif"
              textAnchor="end"
            >
              12 months
            </SvgText>
          </Svg>
        ) : (
          <View style={{ height: H }} />
        )}
      </View>
      <Gate id="projectionFootnote">
        <Text style={styles.footnote}>
          Assumes a typical yearly swing of {Math.round(SWING[risk] * 100)}% for{' '}
          {risk.toLowerCase()}
          -risk mixes (sample assumption until live price history is connected). A rough guide, not
          a promise.
        </Text>
      </Gate>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  projChart: { marginTop: 8 },
  answer: { gap: 12 },
  cardTitle: { color: c.text, fontSize: 17, fontWeight: '600' },
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: c.canvas },
  top: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 },
  titleWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  title: { color: c.text, fontSize: 17, fontWeight: '700' },
  modelChip: {
    height: 22,
    paddingHorizontal: 8,
    justifyContent: 'center',
    borderRadius: 11,
    backgroundColor: c.card,
  },
  modelText: { color: c.textSecondary, fontSize: 12, fontWeight: '600' },
  topSpacer: { width: 24 },
  // Scrolls, so the keyboard pushes the ideas under the header instead of over it.
  flexFill: { flex: 1 },
  welcome: {
    flexGrow: 1,
    paddingVertical: 12,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    gap: 6,
  },
  // A short top block, so the four idea cards fit above the composer.
  welcomeIcon: { marginBottom: 10 },
  welcomeTitle: {
    marginTop: 4,
    color: c.text,
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  welcomeHint: { color: c.textSecondary, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  starters: { marginTop: 14, width: '100%' },
  thread: { paddingHorizontal: 16, paddingVertical: 12, gap: 16 },
  youRow: { alignItems: 'flex-end' },
  you: {
    maxWidth: '82%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    ...radius(20),
    backgroundColor: c.raised,
  },
  youText: { color: c.text, fontSize: 16, lineHeight: 22 },
  agent: { gap: 8 },
  agentHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  agentAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
  },
  agentName: { color: c.text, fontSize: 15, fontWeight: '700' },
  agentBody: { gap: 12 },
  actions: { flexDirection: 'row', gap: 4, marginLeft: -6 },
  action: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  agentText: { color: c.text, fontSize: 16, lineHeight: 23 },
  muted: { color: c.textSecondary, fontSize: 14 },
  // A section's quiet label, as on a jar's page (15pt, secondary).
  sectionLabel: { marginBottom: 4, color: c.textSecondary, fontSize: 15 },
  list: { gap: 6 },
  listItem: { flexDirection: 'row', gap: 8 },
  listText: { color: c.text, fontSize: 15, lineHeight: 21 },
  leftOut: { color: c.textSecondary, fontSize: 14, lineHeight: 19 },
  // A pick row's reason, as the row's own subtitle reads.
  rowReason: { color: c.textSecondary, fontSize: 14, lineHeight: 19 },
  card: { padding: 16, gap: 12, ...radius(20), backgroundColor: c.card },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  cardValue: { color: c.text, fontSize: 26, fontWeight: '700', fontVariant: ['tabular-nums'] },
  sources: { gap: 6 },
  sourcesLabel: { color: c.textSecondary, fontSize: 12, fontWeight: '600' },
  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  source: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 24,
    paddingHorizontal: 8,
    borderRadius: 12,
    backgroundColor: c.raised,
    maxWidth: '100%',
  },
  sourceSample: { backgroundColor: c.accentSurface },
  sourceText: { flexShrink: 1, color: c.textSecondary, fontSize: 12 },
  ctas: { flexDirection: 'row', gap: 8 },
  footnote: { color: c.textSecondary, fontSize: 12, lineHeight: 17 },
  replies: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  reply: {
    height: 34,
    paddingHorizontal: 14,
    justifyContent: 'center',
    borderRadius: 17,
    borderWidth: 1,
    borderColor: c.divider,
  },
  replyText: { color: c.text, fontSize: 14 },
  composerWrap: { paddingHorizontal: 16, paddingTop: 8, gap: 8, backgroundColor: c.canvas },
  linkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
    backgroundColor: c.card,
  },
  linkText: { maxWidth: 160, color: c.text, fontSize: 13 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 6,
    ...radius(24),
    backgroundColor: c.card,
  },
  attach: {
    width: ROW,
    height: ROW,
    borderRadius: ROW / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disclaimer: { color: c.textSecondary, fontSize: 12, textAlign: 'center' },
  input: {
    flex: 1,
    minHeight: ROW,
    paddingVertical: 8,
    paddingHorizontal: 0,
    color: c.text,
    fontSize: 16,
    lineHeight: 20,
  },
  send: {
    width: ROW,
    height: ROW,
    borderRadius: ROW / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
  },
  sendOff: { backgroundColor: c.raised },
}));
