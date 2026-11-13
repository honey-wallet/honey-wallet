import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { PressableRow } from '@/components/motion/PressableRow';
import { SaveButton } from '@/components/motion/SaveButton';
import {
  SkeletonBar,
  SkeletonCard,
  SkeletonList,
  SkeletonReveal,
  useFirstLoad,
} from '@/components/motion/Skeleton';
import { PILL_HEIGHT, PillButton } from '@/components/onboarding/PillButton';
import { buyToo, MascotEmpty, ReturnText, TokenStack } from '@/components/social/parts';
import { Change, HEADER_BUTTON, Sparkline, TokenIcon } from '@/components/wallet/parts';
import { api } from '@/lib/api';
import { backendSessionToken } from '@/lib/backend-session';
import { tap } from '@/lib/haptics';
import { LOADS } from '@/lib/loads';
import { useLivePrices, useMarketList, useTokenChart } from '@/lib/market';
import { formatPrice, MARKET } from '@/lib/mock-wallet';
import { removeSavedStrategy, type SavedStrategy, sinceSaved, useSaved } from '@/lib/saved';
import { openSocialJar } from '@/lib/social';
import { useRestored } from '@/lib/store';
import { TEST_MODE } from '@/lib/test-mode';
import { manualProposal } from '@/lib/thesis';
import { chatDraft } from '@/lib/thesis-chat';
import { requireSignIn } from '@/lib/wallet-gate';
import { makeStyles, radius, useTheme } from '@/theme';

const savedOn = (at: number) =>
  at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';

/**
 * Jars → Saved: the wishlist (lib/saved.ts). Strategies first (jars and theses you saved,
 * with how they've done since you saved them and "Make this jar"), then tokens (Search's
 * market row with a week's line and Buy). Saving works without a wallet; making a jar or
 * buying asks for one then.
 */
export function SavedSection({ onExplore }: { onExplore: () => void }) {
  // The list is restored from the phone a moment after launch: rows-shaped skeletons
  // until then, never a flash of the empty state.
  const firstLoad = useFirstLoad(LOADS.jars);
  const restored = useRestored();
  const loading = firstLoad || !restored;
  return (
    <SkeletonReveal loading={loading} skeleton={<SavedSkeleton />}>
      <SavedList onExplore={onExplore} />
    </SkeletonReveal>
  );
}

function SavedList({ onExplore }: { onExplore: () => void }) {
  const styles = useStyles();
  const { strategies, tokens } = useSaved();
  // Reached with nothing saved (the last one just removed): one line and the way back.
  if (!strategies.length && !tokens.length)
    return (
      <MascotEmpty
        title="Nothing saved yet"
        hint="Tap the heart on a post or a token to keep it here."
        action={{ label: 'Open Feed', onPress: onExplore }}
      />
    );
  return (
    <View>
      {strategies.length ? (
        <>
          <Text style={[styles.heading, styles.section]}>Strategies</Text>
          <View style={styles.cards}>
            {strategies.map((s) => (
              <SavedCard key={s.key} strategy={s} />
            ))}
          </View>
        </>
      ) : null}
      {tokens.length ? (
        <>
          <Text style={[styles.heading, styles.section]}>Tokens</Text>
          {tokens.map((t) => (
            <SavedTokenRow key={t.symbol} symbol={t.symbol} />
          ))}
        </>
      ) : null}
    </View>
  );
}

/** A saved jar opens the usual copy flow; a saved thesis becomes a jar in equal parts. */
async function makeThisJar(s: SavedStrategy) {
  if (!requireSignIn('make this jar', '/saved')) return;
  tap();
  if (s.kind === 'jar') {
    try {
      const jar = await api.socialJar(s.id, backendSessionToken());
      router.push({
        pathname: '/thesis-new',
        params: { step: 'proposal', copy: openSocialJar(jar) },
      });
      return;
    } catch {
      // Unpublished or offline: build it from what was saved instead.
    }
  }
  chatDraft.set(
    manualProposal(
      s.picks.map((p) => ({ symbol: p.symbol, name: p.symbol, chain: p.chain })),
      0,
    ),
  );
  router.push({ pathname: '/thesis-new', params: { step: 'proposal', manual: '1' } });
}

function SavedCard({ strategy: s }: { strategy: SavedStrategy }) {
  const styles = useStyles();
  const c = useTheme();
  const prices = useLivePrices();
  const ret = sinceSaved(s, prices);
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <TokenStack symbols={s.picks.map((p) => p.symbol)} size={26} ring={c.card} />
        <View style={styles.flex} />
        <View style={styles.right}>
          <ReturnText value={ret} size={22} weight="700" />
          <Text style={styles.mutedSmall}>since you saved</Text>
        </View>
        {/* Saved, top right in its 36pt box as on a post: tap to remove it. */}
        <View style={styles.save}>
          <SaveButton saved onToggle={() => removeSavedStrategy(s.key)} />
        </View>
      </View>
      <Text style={styles.cardTitle} numberOfLines={1}>
        {s.kind === 'post' ? `${s.owner}'s thesis: ${s.name}` : s.name}
      </Text>
      {s.thesis ? (
        <Text style={styles.thesis} numberOfLines={3}>
          {s.thesis}
        </Text>
      ) : null}
      <Text style={styles.muted} numberOfLines={1}>
        @{s.owner} · saved {savedOn(s.savedAt)}
      </Text>
      <View style={styles.cardActions}>
        <PillButton
          size="compact"
          label="Make this jar"
          accessibilityLabel={`Make ${s.name} as a jar`}
          onPress={() => void makeThisJar(s)}
        />
      </View>
    </View>
  );
}

/** Search's market row for a saved token, with its week as a line and Buy. */
function SavedTokenRow({ symbol }: { symbol: string }) {
  const styles = useStyles();
  const list = useMarketList();
  const token =
    list.find((t) => t.symbol === symbol) ?? MARKET.find((t) => t.symbol === symbol) ?? null;
  // The week's line from the token page's own chart data (CoinGecko via the server).
  const week = useTokenChart(symbol, '1W', !TEST_MODE).prices;
  return (
    <PressableRow
      accessibilityRole="button"
      accessibilityLabel={`${symbol}, open token`}
      onPress={() => {
        tap();
        router.push({ pathname: '/token/[symbol]', params: { symbol } });
      }}
      style={styles.row}
    >
      <TokenIcon symbol={symbol} size={40} />
      <View style={styles.flex}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {token?.name ?? symbol}
        </Text>
        <Text style={styles.muted}>{symbol}</Text>
      </View>
      {week.length > 1 ? <Sparkline data={week} width={56} height={24} /> : null}
      {/* Price and move once the market has it; bars meanwhile, not a dash. */}
      <View style={styles.right}>
        {token ? (
          <>
            <Text style={styles.rowTitle}>{formatPrice(token.price)}</Text>
            <Change value={token.change} />
          </>
        ) : (
          <View style={styles.valueSkeleton}>
            <SkeletonBar width={64} height={14} />
            <SkeletonBar width={42} height={12} />
          </View>
        )}
      </View>
      <PillButton
        size="compact"
        label="Buy"
        accessibilityLabel={`Buy ${symbol}`}
        onPress={() => buyToo(symbol, token?.chain ?? 'Ethereum')}
      />
    </PressableRow>
  );
}

/** A saved strategy card and token rows while the list loads. */
function SavedSkeleton() {
  const styles = useStyles();
  return (
    <View>
      <View style={[styles.section, styles.headingSkeleton]}>
        <SkeletonBar width={90} height={15} />
      </View>
      <SkeletonCard style={styles.card}>
        <View style={styles.cardTop}>
          <SkeletonBar width={64} height={26} radius={13} />
          <View style={styles.flex} />
          <SkeletonBar width={72} height={22} radius={6} />
        </View>
        <SkeletonBar width="55%" height={17} />
        <SkeletonBar width="85%" height={13} />
        <SkeletonBar width="40%" height={12} />
        <View style={styles.cardActions}>
          <SkeletonBar width={140} height={PILL_HEIGHT.compact} radius={PILL_HEIGHT.compact / 2} />
        </View>
      </SkeletonCard>
      <View style={[styles.section, styles.headingSkeleton]}>
        <SkeletonBar width={60} height={15} />
      </View>
      <SkeletonList count={3} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  flex: { flex: 1 },
  right: { alignItems: 'flex-end' },
  section: { marginTop: 24 },
  // The coin page's section heading.
  heading: { marginBottom: 10, color: c.textSecondary, fontSize: 15 },
  headingSkeleton: { marginBottom: 10 },
  valueSkeleton: { alignItems: 'flex-end', gap: 8 },
  cards: { gap: 12 },
  card: { gap: 8, padding: 14, ...radius(18), backgroundColor: c.card },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardTitle: { color: c.text, fontSize: 17, fontWeight: '700' },
  thesis: { color: c.textSecondary, fontSize: 14, lineHeight: 19 },
  muted: { color: c.textSecondary, fontSize: 13 },
  mutedSmall: { color: c.textSecondary, fontSize: 12, marginTop: -2 },
  // The main action sits last (bottom-right); Save is up top, as on a post.
  cardActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  save: {
    width: HEADER_BUTTON,
    height: HEADER_BUTTON,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -8,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  rowTitle: { color: c.text, fontSize: 16, fontWeight: '600' },
}));
