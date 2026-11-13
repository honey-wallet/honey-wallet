import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { Mix } from '@/components/jars/JarParts';
import { PillButton } from '@/components/onboarding/PillButton';
import { KeyboardFooter } from '@/components/sheets/KeyboardFooter';
import { SHEET, SheetRow, SheetScreen, SheetText } from '@/components/sheets/Sheet';
import { SocialAvatar, thesisSlices } from '@/components/social/parts';
import { Chip } from '@/components/wallet/Chip';
import { TokenIcon } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { MAX_POST_TOKENS, tokenSuggestions, tokensMentioned } from '@/lib/compose';
import { limit, success, tap } from '@/lib/haptics';
import { uniqueBySymbol, useMarketList } from '@/lib/market';
import { formatPrice } from '@/lib/mock-wallet';
import { useSavedTokens } from '@/lib/saved';
import { createPost, socialError, useSocialMe } from '@/lib/social';
import { runThesis, STAGES, ThesisError } from '@/lib/thesis';
import { showErrorToast, showToast } from '@/lib/toast';
import { makeStyles, useTheme } from '@/theme';

/** A thesis is a post, not an essay. */
const MAX_CHARS = 280;
/** The count shows only near the end, as on X. */
const COUNT_FROM = 200;
/** "Add SOL" chips offered for tokens the words mention. */
const MENTIONS = 3;
/** The agent sizes a strategy; a post only keeps its tokens, so any amount and risk do. */
const AGENT_INPUT = { amount: 500, risk: 'Medium' } as const;

type Token = { symbol: string; chain: string };

/**
 * "Share a thesis": a few lines on why, about 1 to 10 tokens. The server snapshots each
 * token's price, so the feed shows how the call has done since (as Fomo's Thesis rows
 * do). Opened from the Feed's +, a token page (that token filled in) or your jar.
 */
export default function ComposeSheet() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const c = useTheme();
  const params = useLocalSearchParams<{ symbol?: string; chain?: string; jar?: string }>();
  const { me, loaded } = useSocialMe();
  const list = useMarketList();
  const saved = useSavedTokens();
  const [body, setBody] = useState('');
  const [tokens, setTokens] = useState<Token[]>(() =>
    params.symbol ? [{ symbol: params.symbol, chain: params.chain ?? '' }] : [],
  );
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [posting, setPosting] = useState(false);
  /** The agent's current stage while it picks, else null. */
  const [stage, setStage] = useState<number | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  // A token from a page may have come without its chain: take the list's.
  const resolved = tokens.map((t) =>
    t.chain ? t : { ...t, chain: list.find((m) => m.symbol === t.symbol)?.chain ?? '' },
  );
  const picked = resolved.map((t) => t.symbol);
  const full = resolved.length >= MAX_POST_TOKENS;
  const text = body.trim();
  const mentioned = useMemo(() => tokensMentioned(text, list), [text, list]);
  const offers = full ? [] : mentioned.filter((t) => !picked.includes(t.symbol)).slice(0, MENTIONS);
  const suggestions =
    // One row per symbol: NEAR Intents picks the chain when it's bought.
    searching && !full
      ? uniqueBySymbol(tokenSuggestions({ query, list, mentioned, saved, picked }))
      : [];
  const ready =
    text.length > 0 &&
    text.length <= MAX_CHARS &&
    resolved.length > 0 &&
    resolved.every((t) => t.chain);

  const add = (t: Token) => {
    setTokens((prev) =>
      prev.length >= MAX_POST_TOKENS || prev.some((p) => p.symbol === t.symbol)
        ? prev
        : [...prev, { symbol: t.symbol, chain: t.chain }],
    );
    setQuery('');
  };

  // The agent reads the thesis and its picks land here as chips (a post is equal parts,
  // so its weights aren't kept). Tokens you'd already added stay.
  const askAgent = async () => {
    if (!text || stage !== null) return;
    tap();
    setStage(0);
    try {
      const proposal = await runThesis({ text, ...AGENT_INPUT }, (at) => {
        if (alive.current) setStage(at);
      });
      if (!alive.current) return;
      const found = proposal.picks.map((p) => {
        const listed = list.find((m) => m.symbol.toUpperCase() === p.symbol.toUpperCase());
        return listed
          ? { symbol: listed.symbol, chain: listed.chain }
          : { symbol: p.symbol, chain: p.chain };
      });
      const fresh = found.filter((f) => !picked.includes(f.symbol));
      if (!fresh.length) {
        limit();
        showToast(found.length ? 'Those tokens are already in' : 'The agent found nothing to add');
      } else {
        success();
        setTokens((prev) => {
          const next = [...prev];
          for (const f of fresh)
            if (next.length < MAX_POST_TOKENS && !next.some((p) => p.symbol === f.symbol))
              next.push(f);
          return next;
        });
      }
    } catch (error) {
      if (alive.current)
        showErrorToast(error instanceof ThesisError ? error.message : 'The agent couldn’t finish');
    } finally {
      if (alive.current) setStage(null);
    }
  };

  const post = async () => {
    if (!ready || posting) return;
    tap();
    setPosting(true);
    try {
      await createPost({ body: text, tokens: resolved, jarId: params.jar ?? null });
      success();
      showToast('Thesis posted');
      router.back();
    } catch (error) {
      setPosting(false);
      showErrorToast(socialError(error));
    }
  };

  // Posting needs a handle: claim one first (the composer is still here after).
  if (loaded && !me)
    return (
      <SheetScreen
        title="Share a thesis"
        footer={
          <PillButton
            label="Claim your handle"
            onPress={() => {
              tap();
              router.replace('/claim-handle');
            }}
          />
        }
      >
        <SheetText lead>Theses post under your @handle: claim one first.</SheetText>
      </SheetScreen>
    );

  const step = stage === null ? null : Math.min(stage, STAGES.length - 1);
  return (
    <SheetScreen
      title="Share a thesis"
      scroll
      pinFooter
      footer={
        // Rides above the keyboard, which is up the whole time you write.
        <KeyboardFooter under={insets.bottom + SHEET.bottom}>
          <PillButton
            label={posting ? 'Posting…' : 'Post'}
            disabled={!ready || posting}
            onPress={() => void post()}
          />
        </KeyboardFooter>
      }
    >
      {/* As on X: your face beside what you're writing, then what it's about. */}
      <View style={styles.compose}>
        {me ? <SocialAvatar who={me} size={40} /> : null}
        <View style={styles.flex}>
          <Text style={styles.handle}>{me ? `@${me.handle}` : ''}</Text>
          <TextInput
            value={body}
            onChangeText={setBody}
            onFocus={() => setSearching(false)}
            placeholder="This is my thesis…"
            placeholderTextColor={c.placeholder}
            multiline
            autoFocus
            maxLength={MAX_CHARS + 20}
            style={styles.body}
            accessibilityLabel="Your thesis"
          />
          {text.length > COUNT_FROM ? (
            <Text style={[styles.count, text.length > MAX_CHARS && { color: c.error }]}>
              {text.length}/{MAX_CHARS}
            </Text>
          ) : null}
          {resolved.length || offers.length ? (
            <View style={styles.chips}>
              {resolved.map((t) => (
                <Chip
                  key={t.symbol}
                  label={t.symbol}
                  variant="filled"
                  leading={<TokenIcon symbol={t.symbol} size={24} />}
                  trailing={<Icon name="close" size={12} color={c.textSecondary} />}
                  accessibilityLabel={`Remove ${t.symbol}`}
                  onPress={() => setTokens((prev) => prev.filter((p) => p.symbol !== t.symbol))}
                />
              ))}
              {/* Tokens the words mention: one tap to add, never added for you. */}
              {offers.map((t) => (
                <Chip
                  key={`add-${t.symbol}`}
                  label={`Add ${t.symbol}`}
                  leading={<TokenIcon symbol={t.symbol} size={24} />}
                  onPress={() => add(t)}
                />
              ))}
            </View>
          ) : null}
          {/* The split exactly as the feed will draw it. */}
          {resolved.length > 1 ? (
            <View style={styles.mix}>
              <Mix picks={thesisSlices(picked)} />
            </View>
          ) : null}
        </View>
      </View>
      <View style={styles.rule} />
      <View style={!text && step === null ? styles.off : undefined}>
        <SheetRow
          title="Let the agent pick"
          subtitle={
            step !== null
              ? `${STAGES[step]}…`
              : text
                ? 'Picks tokens for what you wrote'
                : 'Write your thesis first'
          }
          icon="chat"
          leading={
            step !== null ? (
              <View style={styles.agentIcon}>
                <ActivityIndicator size="small" color={c.textSecondary} />
              </View>
            ) : undefined
          }
          value={step !== null ? `${step + 1}/${STAGES.length}` : undefined}
          accessibilityLabel={step !== null ? 'The agent is picking tokens' : undefined}
          onPress={text && step === null ? () => void askAgent() : undefined}
        />
      </View>
      {full ? (
        <Text style={styles.hint}>{MAX_POST_TOKENS} tokens is the most a thesis can name</Text>
      ) : (
        <View style={styles.search}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            onFocus={() => setSearching(true)}
            placeholder="Add tokens"
          />
          {suggestions.map((t) => (
            <SheetRow
              key={t.symbol}
              leading={<TokenIcon symbol={t.symbol} size={36} ring={c.sheet} />}
              title={t.symbol}
              subtitle={t.name && t.name !== t.symbol ? t.name : undefined}
              value={t.price ? formatPrice(t.price) : undefined}
              accessibilityLabel={`Add ${t.symbol}`}
              onPress={() => {
                tap();
                add(t);
              }}
            />
          ))}
          {searching && query.trim() && !suggestions.length ? (
            <Text style={styles.hint}>{list.length ? 'No tokens match' : 'Loading tokens…'}</Text>
          ) : null}
        </View>
      )}
    </SheetScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  handle: { color: c.text, fontSize: 15, fontWeight: '700' },
  compose: { flexDirection: 'row', gap: 12, marginTop: 8 },
  rule: { height: 1, marginTop: 16, marginBottom: 4, backgroundColor: c.divider },
  body: {
    marginTop: 4,
    minHeight: 48,
    maxHeight: 200,
    padding: 0,
    color: c.text,
    fontSize: 18,
    lineHeight: 23,
    textAlignVertical: 'top',
  },
  count: {
    alignSelf: 'flex-end',
    marginTop: 6,
    color: c.textSecondary,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 },
  mix: { marginTop: 14 },
  agentIcon: { width: 26, alignItems: 'center' },
  off: { opacity: 0.45 },
  hint: { marginTop: 12, color: c.textSecondary, fontSize: 14 },
  search: { marginTop: 8, gap: 4 },
}));
