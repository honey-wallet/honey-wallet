import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, LinearGradient, Path, Stop, Text as SvgText } from 'react-native-svg';
import { Icon } from '@/components/Icon';
import { CitedText, SourcesRow } from '@/components/jars/Citations';
// import { ChatRow } from '@/components/jars/ChatRow'; (Recent chats, commented out below)
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
import { useMoney } from '@/lib/fx';
import { tap } from '@/lib/haptics';
import { chartableTokens } from '@/lib/market';
import { goBackOr } from '@/lib/navigation';
import { COPY_STEPS, useSettings } from '@/lib/settings';
import {
  cashShare,
  hostOf,
  linksIn,
  // type Pick, (only the commented-out USDC row used it)
  type Proposal,
  RISKS,
  type Risk,
  ThesisError,
  ThesisStopped,
  withAmount,
} from '@/lib/thesis';
import {
  bearBullets,
  type ChatMessage,
  type ChatPart,
  chatAsk,
  chatDraft,
  chatPending,
  chatStake,
  leftOut,
  // money, (amounts read in the user's currency now: shortMoney(useMoney().format))
  nearestStep,
  newMessage,
  plainWithSources,
  projection,
  RETRY,
  replay,
  reply,
  SWING,
  shortMoney,
} from '@/lib/thesis-chat';
// Recent chats on the empty state, commented out below:
// import {
//   fetchPastChats,
//   type HistoryRow,
//   hiddenChats,
//   historySections,
//   visibleChats,
// } from '@/lib/thesis-history';
import { showToast } from '@/lib/toast';
// import { tokenColor } from '@/lib/token-colors'; (only the commented-out USDC row used it)
import { Gate } from '@/lib/warnings';
import { makeStyles, radius, useTheme } from '@/theme';
import { DURATION } from '@/theme/motion';

// Unused since the Kept in USDC row left the card (2026-11-14).
// /** The cash the risk rules keep aside, drawn as a USDC row. */
// const USDC: Pick = {
//   symbol: 'USDC',
//   name: 'USD Coin',
//   chain: 'Base',
//   weight: 0,
//   match: 'direct',
//   reason: '',
//   color: tokenColor('USDC'),
// };

/** One line of the message box, and the size of its round buttons. */
const ROW = 36;
/** The message box grows with what you type, to about five lines. */
const MAX_INPUT = 120;
/** Within this of the end, the thread counts as "at the latest" and follows new text. */
const NEAR_END = 40;
/** Scrolled further up than this, "Jump to latest" shows. */
const JUMP_AFTER = 160;

/** Sets Create jar to the step nearest a typed amount, and says which. */
const stakeAt = (amount: number) => {
  const step = nearestStep(amount, COPY_STEPS);
  chatStake.set(step);
  return step;
};

/** "Make it safer", "Show charts": a reply's words, as plain text for Copy and Share. */
function plainText(message: ChatMessage) {
  return message.parts
    .flatMap((p) => {
      // if (p.type === 'text') return [p.text];
      if (p.type === 'text') return [plainWithSources(p.text, p.sources)];
      if (p.type === 'strategy' && p.proposal.picks.length)
        return [
          `${p.proposal.thesis} (${p.proposal.risk.toLowerCase()} risk)`,
          ...p.proposal.picks.map(
            (x) => `${x.symbol} ${x.weight}%${x.reason ? `: ${x.reason}` : ''}`,
          ),
          ...(p.proposal.cashPct ? [`Kept in USDC ${p.proposal.cashPct}%`] : []),
        ];
      return [];
    })
    .join('\n');
}

/**
 * The idea chat: say what you believe (words or links), the agent researches it and
 * answers with things you can act on: a strategy with Create jar, a projection chart,
 * price charts and quick replies. Ask anything about it after. Laid out as Claude's and
 * ChatGPT's phone apps: your words in a bubble on the right, Honey's full width, the
 * thread following the newest text unless you scroll up (then "Jump to latest"), and a
 * composer that grows with what you type, with Send turning into Stop while it works.
 */
export default function ThesisChatScreen() {
  const styles = useStyles();
  const c = useTheme();
  const fx = useMoney();
  const insets = useSafeAreaInsets();
  const { idea, run, said } = useLocalSearchParams<{
    idea?: string;
    /** A past chat opened from History: its saved answer, to carry on from. */
    run?: string;
    said?: string;
  }>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [inputHeight, setInputHeight] = useState(ROW);
  const strategy = useRef<Proposal | null>(null);
  // The message a failed run was answering, for its Try again.
  const retry = useRef<string | null>(null);
  // The run in progress, so Stop (and leaving the chat) stops following it.
  const working = useRef<AbortController | null>(null);
  const list = useRef<FlatList<ChatMessage>>(null);
  const input = useRef<TextInput>(null);
  // Following the newest text, unless you've scrolled up to read.
  const pinned = useRef(true);
  const dragging = useRef(false);
  const [jump, setJump] = useState(false);

  const toEnd = (animated: boolean) => list.current?.scrollToEnd({ animated });
  // Cards fold, fade and slide in after their size is first reported: once they settle,
  // follow to the end again, so the newest line is never left under the composer.
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const follow = () => {
    if (!pinned.current) return;
    toEnd(false);
    clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      if (pinned.current) toEnd(true);
    }, 350);
  };

  /** Runs one turn of the conversation into a new reply from Honey. */
  const answerInto = async (
    you: ChatMessage | null,
    work: (update: (parts: ChatPart[]) => void, signal: AbortSignal) => Promise<void>,
    failed: (error: unknown) => string,
  ) => {
    working.current?.abort();
    const stop = new AbortController();
    working.current = stop;
    setBusy(true);
    const answer = newMessage('agent', []);
    setMessages((m) => [...m, ...(you ? [you] : []), answer]);
    pinned.current = true;
    setJump(false);
    requestAnimationFrame(() => toEnd(true));
    const update = (parts: ChatPart[]) => {
      if (working.current !== stop) return;
      setMessages((m) => m.map((x) => (x.id === answer.id ? { ...x, parts } : x)));
    };
    try {
      await work(update, stop.signal);
    } catch (error) {
      if (working.current !== stop && !(error instanceof ThesisStopped)) return;
      // Stopped: keep what it had understood, drop the live steps, offer to run it again.
      setMessages((m) =>
        m.map((x) =>
          x.id === answer.id
            ? {
                ...x,
                parts: [
                  ...(error instanceof ThesisStopped
                    ? x.parts.filter((p) => p.type === 'understood')
                    : []),
                  { type: 'text', text: failed(error) },
                  ...(you || retry.current ? [{ type: 'replies' as const, options: [RETRY] }] : []),
                ],
              }
            : x,
        ),
      );
    } finally {
      if (working.current === stop) {
        working.current = null;
        setBusy(false);
      }
    }
  };

  const send = (text: string) => {
    const typed = text.trim();
    if (!typed || busy) return;
    // Try again re-asks what failed, not the words "Try again".
    const asked = typed === RETRY && retry.current ? retry.current : typed;
    retry.current = null;
    tap();
    setDraft('');
    setInputHeight(ROW);
    void answerInto(
      newMessage('you', [{ type: 'text', text: typed }]),
      async (update, signal) => {
        strategy.current = await reply(asked, strategy.current, {
          update,
          signal,
          stake: stakeAt,
          // Amounts in the words as Create jar shows them: the user's currency.
          format: shortMoney(fx.format),
          ...chartableTokens(),
        });
      },
      (error) => {
        retry.current = asked;
        return error instanceof ThesisError
          ? error.message
          : "I couldn't finish that. Nothing was bought or signed.";
      },
    );
  };

  /** Stop: stops following the run. The server finishes it, and History keeps it. */
  const stop = () => {
    tap();
    working.current?.abort();
  };

  // A past chat: the idea as it was asked, then its saved answer (or the run, still going).
  const open = (runId: string) => {
    const you = said ? newMessage('you', [{ type: 'text', text: said }]) : null;
    void answerInto(
      you,
      async (update, signal) => {
        const past = await replay(runId, said ?? '', { update, signal });
        strategy.current = past.proposal;
        if (you && past.text && past.text !== said)
          setMessages((m) =>
            m.map((x) =>
              x.id === you.id ? { ...x, parts: [{ type: 'text', text: past.text }] } : x,
            ),
          );
      },
      (error) =>
        error instanceof ThesisError ? error.message : "I couldn't open this chat right now.",
    );
  };

  /** New chat: back to the empty chat, whatever was going on. */
  // biome-ignore lint/correctness/noUnusedVariables: kept for New chat, off the top bar for now.
  const fresh = () => {
    working.current?.abort();
    working.current = null;
    strategy.current = null;
    retry.current = null;
    chatStake.set(null);
    chatPending.set(null);
    setBusy(false);
    setMessages([]);
    setDraft('');
    setInputHeight(ROW);
    setJump(false);
    pinned.current = true;
  };

  // Back from How much? with a change of risk: ask it here, in the conversation.
  useFocusEffect(
    // biome-ignore lint/correctness/useExhaustiveDependencies: reads the latest send
    useCallback(() => {
      const ask = chatAsk.get();
      if (!ask) return;
      chatAsk.set(null);
      send(ask);
    }, [busy]),
  );

  // An idea passed in (from the Jars field) starts the chat straight away; a past chat
  // opens on its answer. Leaving stops following a run (History keeps it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useEffect(() => {
    chatStake.set(null);
    chatPending.set(null);
    if (run) open(run);
    else if (idea) send(idea);
    return () => {
      working.current?.abort();
      clearTimeout(settle.current);
    };
  }, []);

  const empty = messages.length === 0;
  // Only the newest strategy can be bought; older ones say they were updated.
  const latestStrategy =
    [...messages].reverse().find((m) => m.parts.some((p) => p.type === 'strategy'))?.id ?? null;

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const fromEnd = contentSize.height - layoutMeasurement.height - contentOffset.y;
    if (fromEnd < NEAR_END) pinned.current = true;
    else if (dragging.current) pinned.current = false;
    const show = !pinned.current && fromEnd > JUMP_AFTER;
    if (show !== jump) setJump(show);
  };

  const keyboard = useKeyboardShown();
  const typed = !!draft.trim();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.screen, { paddingTop: insets.top }]}
    >
      <View style={styles.top}>
        <View style={styles.side}>
          <HeaderShortcut icon="chevronLeft" label="Back" onPress={() => goBackOr('/jars')} />
        </View>
        <View style={styles.titleWrap}>
          <Text style={styles.title}>Thesis agent</Text>
        </View>
        <View style={[styles.side, styles.sideEnd]}>
          {/* New chat taken off the top bar (2026-11-14, the user's call); History stays.
          <HeaderShortcut
            icon="pencil"
            label="New chat"
            onPress={() => {
              fresh();
              if (empty) input.current?.focus();
            }}
          />
          */}
          <HeaderShortcut
            icon="history"
            label="History"
            onPress={() => router.push('/thesis-history')}
          />
        </View>
      </View>

      {empty ? (
        <Welcome onIdea={send} />
      ) : (
        <View style={styles.flexFill}>
          <FlatList
            ref={list}
            data={messages}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.thread}
            // Buttons in answers work with the keyboard up; dragging the thread lowers it.
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            onScroll={onScroll}
            scrollEventThrottle={32}
            onScrollBeginDrag={() => {
              dragging.current = true;
            }}
            onScrollEndDrag={() => {
              dragging.current = false;
            }}
            onMomentumScrollBegin={() => {
              dragging.current = true;
            }}
            onMomentumScrollEnd={() => {
              dragging.current = false;
            }}
            // New text keeps the newest line in view, without animating every word.
            onContentSizeChange={follow}
            onLayout={follow}
            renderItem={({ item, index }) => (
              <Message
                message={item}
                onSay={send}
                busy={busy}
                last={index === messages.length - 1}
                latestStrategy={latestStrategy}
                onVariant={(p) => {
                  strategy.current = p;
                }}
              />
            )}
          />
          {jump ? (
            <Animated.View
              entering={FadeIn.duration(DURATION.fast)}
              exiting={FadeOut.duration(DURATION.fast)}
              style={styles.jumpWrap}
              pointerEvents="box-none"
            >
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Jump to latest"
                hitSlop={8}
                scaleTo={0.92}
                onPress={() => {
                  tap();
                  pinned.current = true;
                  setJump(false);
                  toEnd(true);
                }}
                style={styles.jump}
              >
                <Icon name="arrowDown" size={18} color={c.text} />
              </PressableScale>
            </Animated.View>
          ) : null}
        </View>
      )}

      {/* The home-indicator inset only without the keyboard: over it, it left a band. */}
      <View
        style={[styles.composerWrap, { paddingBottom: keyboard ? 8 : Math.max(insets.bottom, 12) }]}
      >
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
            accessibilityHint="Adds a link you've copied, to a post or an article"
            hitSlop={6}
            onPress={async () => {
              tap();
              // A post or article you copied comes in as a link the agent reads.
              const copied = (await Clipboard.getStringAsync().catch(() => '')).trim();
              const url = linksIn(copied)[0];
              if (!url) {
                showToast('Copy a link to a post or article, then tap to add it');
                return;
              }
              setDraft((d) => (d.trim() ? `${d.trimEnd()} ${url}` : url));
              input.current?.focus();
            }}
            style={styles.attach}
          >
            <Icon name="paperclip" size={18} color={c.textSecondary} />
          </PressableScale>
          <TextInput
            ref={input}
            value={draft}
            onChangeText={setDraft}
            placeholder={empty ? 'An idea, or paste a link' : 'Ask anything about it'}
            placeholderTextColor={c.placeholder}
            multiline
            numberOfLines={1}
            // One line to start (a web textarea defaults to two), growing to five.
            onContentSizeChange={(e) =>
              setInputHeight(
                Math.min(MAX_INPUT, Math.max(ROW, Math.ceil(e.nativeEvent.contentSize.height))),
              )
            }
            scrollEnabled={inputHeight >= MAX_INPUT}
            style={[styles.input, { height: inputHeight }]}
            // Enter sends, Shift+Enter adds a line (web and hardware keyboards).
            onKeyPress={(e) => {
              const key = e.nativeEvent as unknown as { key: string; shiftKey?: boolean };
              if (key.key === 'Enter' && !key.shiftKey) {
                (e as unknown as { preventDefault?: () => void }).preventDefault?.();
                send(draft);
              }
            }}
            onSubmitEditing={() => send(draft)}
            submitBehavior="submit"
            accessibilityLabel="Message"
          />
          {busy ? (
            // While it works, Send is Stop: a square, as in Claude and ChatGPT.
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Stop"
              onPress={stop}
              style={styles.send}
            >
              <View style={[styles.stopGlyph, { backgroundColor: c.onPrimary }]} />
            </PressableScale>
          ) : (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Send"
              accessibilityState={{ disabled: !typed }}
              disabled={!typed}
              onPress={() => send(draft)}
              style={[styles.send, !typed && styles.sendOff]}
            >
              <Icon name="arrowUp" size={18} color={typed ? c.onPrimary : c.textSecondary} />
            </PressableScale>
          )}
        </View>
        {keyboard ? null : (
          <Gate id="assistantDisclaimer">
            <Text style={styles.disclaimer}>
              Honey can be wrong. You review and sign every order.
            </Text>
          </Gate>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

/**
 * The empty chat: what to ask, the Jars page's idea cards (each starts the chat), and
 * your last three chats, with History for the rest.
 */
function Welcome({ onIdea }: { onIdea: (text: string) => void }) {
  const styles = useStyles();
  // The Recent list is off the empty state (2026-11-14, the user's call); History has them.
  // const hidden = hiddenChats.useValue();
  // const [recent, setRecent] = useState<HistoryRow[]>([]);
  // useEffect(() => {
  //   let live = true;
  //   fetchPastChats()
  //     .then(({ chats }) => {
  //       if (live) setRecent(historySections(visibleChats(chats, hidden)).flatMap((s) => s.rows));
  //     })
  //     .catch(() => {});
  //   return () => {
  //     live = false;
  //   };
  // }, [hidden]);
  return (
    <ScrollView
      style={styles.flexFill}
      contentContainerStyle={styles.welcome}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      <View style={styles.welcomeTop}>
        <HoneyLogo variant="mark" height={56} />
        <Text style={styles.welcomeTitle}>What do you believe in?</Text>
        {/* <Text style={styles.welcomeHint}>
          Say it any way, or paste a post. Honey finds what you can buy.
        </Text> (off 14 Nov, owner) */}
      </View>
      {/* The Jars page's idea cards, each starting the conversation with its idea. */}
      <IdeaGrid onPick={onIdea} />
      {/* Recent chats, off the empty state (2026-11-14, the user's call).
      {recent.length ? (
        <View style={styles.recent}>
          <View style={styles.recentHead}>
            <Text style={styles.sectionLabel}>Recent</Text>
            <PressableScale
              accessibilityRole="button"
              hitSlop={8}
              scaleTo={0.96}
              onPress={() => {
                tap();
                router.push('/thesis-history');
              }}
            >
              <Text style={styles.seeAll}>See all</Text>
            </PressableScale>
          </View>
          {recent.slice(0, 3).map((row) => (
            <ChatRow key={row.runId} row={row} />
          ))}
        </View>
      ) : null}
      */}
    </ScrollView>
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
  const [rated, setRated] = useState<'up' | 'down' | null>(null);
  if (message.from === 'you')
    return (
      <View style={styles.youRow}>
        <View style={styles.you}>
          <Text style={styles.youText} selectable>
            {message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}
          </Text>
        </View>
      </View>
    );
  const text = plainText(message);
  const cited = message.parts.flatMap((p) => (p.type === 'text' ? (p.sources ?? []) : []));
  const working = busy && last;
  // Quick replies belong to the newest answer only, as in ChatGPT.
  const parts = last ? message.parts : message.parts.filter((p) => p.type !== 'replies');
  const replies = parts.filter((p) => p.type === 'replies');
  const body = parts.filter((p) => p.type !== 'replies');
  const rate = (r: 'up' | 'down') => {
    const next = rated === r ? null : r;
    setRated(next);
    if (next) showToast('Thanks for the feedback');
  };
  return (
    <Animated.View entering={FadeIn.duration(DURATION.fast)} style={styles.agent}>
      {message.parts.length === 0 ? <Typing /> : null}
      {body.map((part, i) => (
        <Part
          // Keyed by kind, so a part keeps its state (the live feed's buffers) when
          // another arrives before it (the idea, once understood).
          key={partKey(body, i)}
          part={part}
          onSay={onSay}
          busy={busy}
          stream={last}
          latest={latestStrategy === message.id}
          onVariant={onVariant}
        />
      ))}
      {/* The sites the answer cites, under it. */}
      {!working && cited.length ? <SourcesRow sources={cited} /> : null}
      {/* Copy, rate and share sit right under the answer; its next steps under them. */}
      {!working && text ? (
        <View style={styles.actions}>
          <Action icon="copy" label="Copy" onPress={() => void copyText(text, 'Copied')} />
          <Action
            icon="thumbsUp"
            label="Good answer"
            active={rated === 'up'}
            onPress={() => rate('up')}
          />
          <Action
            icon="thumbsDown"
            label="Bad answer"
            active={rated === 'down'}
            onPress={() => rate('down')}
          />
          <Action
            icon="share"
            label="Share"
            onPress={() => void Share.share({ message: text }).catch(() => {})}
          />
        </View>
      ) : null}
      {replies.map((part, i) => (
        <Part
          key={partKey(replies, i)}
          part={part}
          onSay={onSay}
          busy={busy}
          stream={last}
          latest={false}
          onVariant={onVariant}
        />
      ))}
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
      <Icon name={icon} size={16} color={active ? c.text : c.textSecondary} />
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
      // return <StreamText text={part.text} stream={stream} />;
      // Cited text shows its sources as pills, inline; the rest types itself out.
      return part.sources?.length ? (
        <CitedText text={part.text} sources={part.sources} style={styles.agentText} />
      ) : (
        <StreamText text={part.text} stream={stream} />
      );
    case 'understood':
      return <Understood theme={part.theme} picks={part.picks} />;
    case 'stages':
      // The steps with their times and live feed: open while it works, folded once done.
      return <ThesisProgress at={part.at} done={part.done} live={part.live} />;
    case 'strategy':
      return <AnswerCard proposal={part.proposal} latest={latest} onVariant={onVariant} />;
    case 'projection':
      return <ProjectionCard risk={part.risk} />;
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
/** The critic's "What could go wrong" under Read more: off since 14 Nov (owner). */
const SHOW_BEAR_CASE: boolean = false;

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
  // The amount on Create jar, shared with the chat's words and the projection.
  const stake = chatStake.useValue();
  const fx = useMoney();
  const levels = RISKS.filter((r) => proposal.byRisk?.[r]);
  const [level, setLevel] = useState<Risk>(proposal.risk);
  const variant = (r: Risk): Proposal =>
    r === proposal.risk || !proposal.byRisk?.[r]
      ? proposal
      : { ...withAmount(proposal.byRisk[r] as Proposal, proposal.amount), byRisk: proposal.byRisk };
  const shown = variant(level);
  // const cash = shown.cashPct && shown.cashPct > 0 ? shown.cashPct : 0;
  // The same cash the bar and its legend draw, so the row and subtitle agree with them.
  const cash = cashShare(shown.picks, shown.cashPct);
  // const left = leftOut(shown.unmatched);
  // Only what Honey left out with a reason worth reading; a bare "Ether" says nothing.
  const left = leftOut(shown.unmatched).filter((u) => u.note);
  const bear = bearBullets(shown.bearCase);
  // Compact by default (2026-11-14, "too much slop text"): one line per pick; the
  // "Wrong if" lines, Left out and What could go wrong open behind Read more.
  const [more, setMore] = useState(false);
  // const hasMore = left.length > 0 || bear.length > 0 || shown.picks.some((p) => p.wrongIf);
  const hasMore = left.length > 0;
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
    <View style={styles.moreBlock}>
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
  // The card is the split, the risk switch and Create jar (2026-11-14, the user's call): the
  // "Why these" rows repeated the bar's legend (XAUT 50%, USDC 50%), so the reasons, Left
  // out and What could go wrong open below the card, behind Read more.
  const hasDetails = hasMore || shown.picks.some((p) => p.reason);
  return (
    <View style={styles.answer}>
      {/* A Feed post's strategy well: coins, name, the striped split, then − Buy 5 [USDC] +. */}
      <StrategyCard
        picks={shown.picks}
        name={shown.thesis}
        meta={`${shown.risk} risk · ${shown.picks.length} ${
          shown.picks.length === 1 ? 'token' : 'tokens'
        }${cash ? ` + ${cash}% cash` : ''}`}
        cashPct={cash}
        split
      >
        {riskSwitch}
        {latest ? (
          <CopyStepper
            primary
            verb="Create jar"
            label="Create jar"
            start={stake ?? undefined}
            onAmount={(amount) => chatStake.set(amount)}
            // "Create jar $5", in the user's currency, not "5 [USDC]" (2026-11-14).
            format={shortMoney(fx.format)}
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
      {hasDetails ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityState={{ expanded: more }}
          hitSlop={8}
          scaleTo={0.97}
          onPress={() => {
            tap();
            setMore((m) => !m);
          }}
          style={styles.readMore}
        >
          <Text style={styles.readMoreText}>{more ? 'Show less' : 'Read more'}</Text>
        </PressableScale>
      ) : null}
      {more && shown.picks.some((p) => p.reason) ? (
        <ContentSwap id={level} index={RISKS.indexOf(level)}>
          <Text style={styles.sectionLabel}>Why these</Text>
          {shown.picks.map((p) => (
            <SheetRow
              key={`${p.symbol}-${p.chain}`}
              leading={<PickIcon pick={p} size={32} />}
              title={p.symbol}
              subtitle={
                <View style={styles.flex}>
                  {p.reason ? <Text style={styles.rowReason}>{p.reason}</Text> : null}
                  {/* {p.wrongIf ? <Text style={styles.footnote}>{wrongIfLine(p.wrongIf)}</Text> : null} (off 14 Nov, owner) */}
                </View>
              }
            />
          ))}
        </ContentSwap>
      ) : null}
      {more ? leftOutBlock : null}
      {/* What could go wrong: off 14 Nov (owner). */}
      {SHOW_BEAR_CASE && more && bear.length ? (
        <View style={styles.moreBlock}>
          <Text style={styles.sectionLabel}>What could go wrong</Text>
          <View style={styles.list}>
            {bear.map((line) => (
              <View key={line} style={styles.listItem}>
                <Text style={styles.listText}>•</Text>
                <CitedText
                  text={line}
                  sources={shown.citations ?? proposal.citations}
                  style={[styles.listText, styles.shrink]}
                />
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

// Was (until 2026-11-14): the Why these rows, Read more and its blocks inside the card.
//   return (
//     // A Feed post's strategy well: coins, name, the striped split, then − Buy 5 [USDC] +.
//     <StrategyCard
//       picks={shown.picks}
//       name={shown.thesis}
//       // meta={`${shown.risk} risk · ${shown.picks.length} ${
//       //   shown.picks.length === 1 ? 'token' : 'tokens'
//       // }`}
//       meta={`${shown.risk} risk · ${shown.picks.length} ${
//         shown.picks.length === 1 ? 'token' : 'tokens'
//       }${cash ? ` + ${cash}% cash` : ''}`}
//       cashPct={cash}
//       split
//     >
//       {riskSwitch}
//       {/* Why each pick, as the app's rows: its logo, the token, the agent's reason (and
//           what would prove it wrong), its share; then what the risk rules kept in USDC.
//           A new risk level slides its rows in from the side it sits on. */}
//       {shown.picks.some((p) => p.reason) || cash ? (
//         <ContentSwap id={level} index={RISKS.indexOf(level)}>
//           <Text style={styles.sectionLabel}>Why these</Text>
//           {shown.picks.map((p) => (
//             <SheetRow
//               key={`${p.symbol}-${p.chain}`}
//               leading={<PickIcon pick={p} size={32} />}
//               title={p.symbol}
//               // subtitle={
//               //   p.wrongIf ? (
//               //     <View style={styles.flex}>
//               //       {p.reason ? <Text style={styles.rowReason}>{p.reason}</Text> : null}
//               //       <Text style={styles.footnote}>{wrongIfLine(p.wrongIf)}</Text>
//               //     </View>
//               //   ) : (
//               //     p.reason
//               //   )
//               // }
//               // One line of reason; its "Wrong if" only behind Read more.
//               subtitle={
//                 <View style={styles.flex}>
//                   {p.reason ? (
//                     <Text style={styles.rowReason} numberOfLines={more ? undefined : 1}>
//                       {p.reason}
//                     </Text>
//                   ) : null}
//                   {more && p.wrongIf ? (
//                     <Text style={styles.footnote}>{wrongIfLine(p.wrongIf)}</Text>
//                   ) : null}
//                 </View>
//               }
//               value={`${p.weight}%`}
//             />
//           ))}
//           {cash ? (
//             <SheetRow
//               leading={<PickIcon pick={USDC} size={32} />}
//               title="Kept in USDC"
//               value={`${cash}%`}
//             />
//           ) : null}
//         </ContentSwap>
//       ) : null}
//       {/* {leftOutBlock} and What could go wrong now open behind Read more. */}
//       {hasMore ? (
//         <PressableScale
//           accessibilityRole="button"
//           accessibilityState={{ expanded: more }}
//           hitSlop={8}
//           scaleTo={0.97}
//           onPress={() => {
//             tap();
//             setMore((m) => !m);
//           }}
//           style={styles.readMore}
//         >
//           <Text style={styles.readMoreText}>{more ? 'Show less' : 'Read more'}</Text>
//         </PressableScale>
//       ) : null}
//       {more ? leftOutBlock : null}
//       {more && bear.length ? (
//         <View style={styles.moreBlock}>
//           <Text style={styles.sectionLabel}>What could go wrong</Text>
//           <View style={styles.list}>
//             {bear.map((line) => (
//               <View key={line} style={styles.listItem}>
//                 <Text style={styles.listText}>•</Text>
//                 {/* <Text style={[styles.listText, styles.shrink]}>{line}</Text> */}
//                 <CitedText
//                   text={line}
//                   sources={shown.citations ?? proposal.citations}
//                   style={[styles.listText, styles.shrink]}
//                 />
//               </View>
//             ))}
//           </View>
//         </View>
//       ) : null}
//       {/* Removed from the card (2026-11-14, the user's call):
//       {latest ? (
//         <Text
//           style={styles.footnote}
//           numberOfLines={1}
//           adjustsFontSizeToFit
//           minimumFontScale={0.85}
//         >
//           Crypto is high risk. Only put in what you can afford to lose.
//         </Text>
//       ) : null}
//       */}
//       {latest ? (
//         <CopyStepper
//           primary
//           verb="Create jar"
//           label="Create jar"
//           start={stake ?? undefined}
//           onAmount={(amount) => chatStake.set(amount)}
//           // "Create jar $5", in the user's currency, not "5 [USDC]" (2026-11-14).
//           format={shortMoney(fx.format)}
//           onCopy={(amount) => {
//             tap();
//             // The level on screen is the one bought.
//             chatDraft.set(withAmount(shown, amount));
//             router.push({ pathname: '/thesis-new', params: { step: 'proposal', from: 'chat' } });
//           }}
//         />
//       ) : (
//         <Text style={styles.muted}>Updated below.</Text>
//       )}
//     </StrategyCard>
//   );
// }

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

/** "Wrong if AI budgets shrink.", however the agent phrased it. */
// biome-ignore lint/correctness/noUnusedVariables: kept for the Wrong if line, off since 14 Nov.
function wrongIfLine(text: string) {
  const t = text.trim();
  if (/^wrong if\b/i.test(t)) return t;
  return `Wrong if ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
}

/**
 * A rough 12-month range: the band between a bad and a good year, the middle line. For
 * the amount on Create jar, so it never names a different one.
 */
function ProjectionCard({ risk }: { risk: Risk }) {
  const styles = useStyles();
  const c = useTheme();
  const stake = chatStake.useValue();
  const { copyAmount } = useSettings();
  const amount = stake ?? copyAmount;
  // The user's currency, as Create jar shows it (was `money`, always dollars).
  const fxMoney = shortMoney(useMoney().format);
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
      {/* <Text style={styles.muted}>{money(amount)} in 12 months, likely</Text> */}
      {/* <Text style={styles.cardValue}>{money(end(mid))}</Text> */}
      <Text style={styles.muted}>{fxMoney(amount)} in 12 months, likely</Text>
      <Text style={styles.cardValue}>{fxMoney(end(mid))}</Text>
      <Text style={styles.muted}>
        {/* Between {money(end(low))} and {money(end(high))} */}
        Between {fxMoney(end(low))} and {fxMoney(end(high))}
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
                  {/* {money(e.v)} */}
                  {fxMoney(e.v)}
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
  shrink: { flexShrink: 1 },
  screen: { flex: 1, backgroundColor: c.canvas },
  top: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 },
  // Both sides the same width, so the title stays centred.
  side: { width: 88, flexDirection: 'row', alignItems: 'center' },
  sideEnd: { justifyContent: 'flex-end', gap: 16 },
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
    paddingVertical: 16,
    justifyContent: 'center',
    paddingHorizontal: 16,
    gap: 20,
  },
  // A short top block, so the idea cards and recent chats fit above the composer.
  welcomeTop: { alignItems: 'center', gap: 6 },
  recent: { gap: 2 },
  recentHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  seeAll: { color: c.accentText, fontSize: 15, fontWeight: '600' },
  welcomeTitle: {
    marginTop: 8,
    color: c.text,
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  welcomeHint: { color: c.textSecondary, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  // Turns 24pt apart; the parts of one answer 12pt apart.
  thread: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 20, gap: 24 },
  youRow: { alignItems: 'flex-end' },
  you: {
    maxWidth: '82%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    ...radius(20),
    backgroundColor: c.raised,
  },
  youText: { color: c.text, fontSize: 16, lineHeight: 22 },
  agent: { gap: 12 },
  actions: { flexDirection: 'row', gap: 4, marginLeft: -7, marginTop: -4 },
  action: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  agentText: { color: c.text, fontSize: 16, lineHeight: 23 },
  muted: { color: c.textSecondary, fontSize: 14 },
  // A section's quiet label, as on a jar's page (15pt, secondary).
  readMore: { alignSelf: 'flex-start' },
  readMoreText: { color: c.accentText, fontSize: 15, fontWeight: '600' },
  moreBlock: { gap: 0 },
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
  stopGlyph: { width: 12, height: 12, borderRadius: 3 },
  jumpWrap: { position: 'absolute', left: 0, right: 0, bottom: 10, alignItems: 'center' },
  jump: {
    width: ROW,
    height: ROW,
    borderRadius: ROW / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.divider,
  },
}));

/** Whether the keyboard is up (iOS reports it as it starts to move). */
function useKeyboardShown() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () =>
      setShown(true),
    );
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setShown(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}
