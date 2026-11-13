import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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
import Svg, { Line, Path, Text as SvgText } from 'react-native-svg';
import { Icon } from '@/components/Icon';
import { Facts, IdeaGrid, StrategyCard } from '@/components/jars/JarParts';
import { StepsCard } from '@/components/jars/StepsCard';
import { HoneyLogo } from '@/components/logo/HoneyLogo';
import { PressableScale } from '@/components/motion/PressableScale';
import { PillButton } from '@/components/onboarding/PillButton';
import { CopyStepper } from '@/components/social/parts';
import { HeaderShortcut } from '@/components/wallet/HeaderShortcut';
import { copyText } from '@/lib/copy';
import { tap } from '@/lib/haptics';
import { goBackOr } from '@/lib/navigation';
import {
  hostOf,
  linksIn,
  type Proposal,
  type Risk,
  STAGES,
  ThesisError,
  withAmount,
} from '@/lib/thesis';
import {
  type ChatMessage,
  type ChatPart,
  chatDraft,
  money,
  newMessage,
  projection,
  reply,
  SWING,
} from '@/lib/thesis-chat';
import { Gate } from '@/lib/warnings';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

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
  const { idea } = useLocalSearchParams<{ idea?: string }>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [inputHeight, setInputHeight] = useState(ROW);
  const strategy = useRef<Proposal | null>(null);
  const list = useRef<FlatList<ChatMessage>>(null);

  const send = async (text: string) => {
    const said = text.trim();
    if (!said || busy) return;
    tap();
    setDraft('');
    setInputHeight(ROW);
    setBusy(true);
    const answer = newMessage('agent', []);
    setMessages((m) => [...m, newMessage('you', [{ type: 'text', text: said }]), answer]);
    const update = (parts: ChatPart[]) =>
      setMessages((m) => m.map((x) => (x.id === answer.id ? { ...x, parts } : x)));
    try {
      strategy.current = await reply(said, strategy.current, { update });
    } catch (error) {
      update([
        {
          type: 'text',
          text:
            error instanceof ThesisError
              ? error.message
              : "I couldn't finish that. Nothing was bought or signed.",
        },
        { type: 'replies', options: [said] },
      ]);
    } finally {
      setBusy(false);
    }
  };

  // An idea passed in (from the Jars field) starts the chat straight away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useEffect(() => {
    if (idea) void send(idea);
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
        <View style={styles.topSpacer} />
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
            />
          )}
        />
      )}

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
    </KeyboardAvoidingView>
  );
}

function Message({
  message,
  onSay,
  busy,
  last,
  latestStrategy,
}: {
  message: ChatMessage;
  onSay: (text: string) => void;
  busy: boolean;
  last: boolean;
  latestStrategy: string | null;
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
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are replaced as a whole
            key={i}
            part={part}
            onSay={onSay}
            busy={busy}
            stream={last}
            latest={latestStrategy === message.id}
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
}: {
  part: ChatPart;
  onSay: (t: string) => void;
  busy: boolean;
  stream: boolean;
  latest: boolean;
}) {
  const styles = useStyles();
  switch (part.type) {
    case 'text':
      return <StreamText text={part.text} stream={stream} />;
    case 'stages':
      // A checklist with a summary header: open while it works, folded once done.
      return (
        <StepsCard
          title="Researching your idea"
          doneTitle="Researched your idea"
          steps={STAGES}
          at={part.done ? STAGES.length : part.at}
        />
      );
    case 'strategy':
      return <AnswerCard proposal={part.proposal} latest={latest} />;
    case 'projection':
      return <ProjectionCard amount={part.amount} risk={part.risk} />;
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
 * The answer you act on (2026-11-13): the Feed's strategy card (coins, name, split) and
 * one Continue to "How much?", where the amount, split and risk are set. Nothing it can
 * buy: say so, with the way to pick tokens yourself.
 */
function AnswerCard({ proposal, latest }: { proposal: Proposal; latest: boolean }) {
  const styles = useStyles();
  if (!proposal.picks.length)
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Nothing to buy for this yet</Text>
        {proposal.unmatched.length ? (
          <Text style={styles.muted}>
            {proposal.unmatched.map((u) => u.idea).join(', ')} aren't tokens you can buy.
          </Text>
        ) : null}
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
      picks={proposal.picks}
      name={proposal.thesis}
      meta={`${proposal.risk} risk · ${proposal.picks.length} ${
        proposal.picks.length === 1 ? 'token' : 'tokens'
      }`}
      split
    >
      {latest ? (
        <CopyStepper
          label="Buy"
          onCopy={(amount) => {
            tap();
            chatDraft.set(withAmount(proposal, amount));
            router.push({ pathname: '/thesis-new', params: { step: 'proposal' } });
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
  const H = 150;
  const max = Math.max(...high);
  const min = Math.min(...low);
  const x = (i: number) => (i / (mid.length - 1)) * (width - 8) + 4;
  const y = (v: number) => 10 + (1 - (v - min) / Math.max(max - min, 1)) * (H - 30);
  const line = (vs: number[]) => vs.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
  const band = `${line(high)}${[...low]
    .reverse()
    .map((v, i) => `L${x(low.length - 1 - i)},${y(v)}`)
    .join('')}Z`;
  return (
    <View style={styles.card}>
      <Text style={styles.muted}>In 12 months, roughly</Text>
      <Text style={styles.cardValue}>
        {money(Math.round(low.at(-1) ?? 0))} – {money(Math.round(high.at(-1) ?? 0))}
      </Text>
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 ? (
          <Svg width={width} height={H}>
            <Path d={band} fill={c.primary} opacity={0.14} />
            <Path d={line(high)} stroke={c.success} strokeWidth={1.5} fill="none" opacity={0.7} />
            <Path d={line(low)} stroke={c.error} strokeWidth={1.5} fill="none" opacity={0.7} />
            <Path d={line(mid)} stroke={c.primary} strokeWidth={2.5} fill="none" />
            <Line
              x1={4}
              x2={width - 4}
              y1={y(amount)}
              y2={y(amount)}
              stroke={c.divider}
              strokeDasharray="4 4"
            />
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
              x={width - 4}
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
      <Facts
        facts={[
          { label: 'Bad year', value: money(Math.round(low.at(-1) ?? 0)) },
          { label: 'Middle', value: money(Math.round(mid.at(-1) ?? 0)) },
          { label: 'Good year', value: money(Math.round(high.at(-1) ?? 0)) },
        ]}
      />
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
