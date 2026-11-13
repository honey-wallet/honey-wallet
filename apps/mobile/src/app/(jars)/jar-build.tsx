import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { SkeletonBar } from '@/components/motion/Skeleton';
import { Sticky } from '@/components/motion/Sticky';
import { PillButton } from '@/components/onboarding/PillButton';
import { KeyboardFooter } from '@/components/sheets/KeyboardFooter';
import { Chip } from '@/components/wallet/Chip';
import { Change, PushedScreen, SCREEN, TokenIcon } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { tap } from '@/lib/haptics';
import {
  isDollar,
  matchesQuery,
  uniqueBySymbol,
  useMarketList,
  useMarketSettled,
} from '@/lib/market';
import { formatCompactUsd, formatPrice, type MarketToken } from '@/lib/mock-wallet';
import { manualProposal } from '@/lib/thesis';
import { chatDraft } from '@/lib/thesis-chat';
import { makeStyles, useTheme } from '@/theme';

/** More than this and a jar stops being a view and becomes an index. */
const MAX_PICKS = 8;
/** Rows drawn per page as you scroll; the list is every token 1Click delivers. */
const SHOWN = 40;
/** Stablecoins aren't a bet; they'd only dilute the jar. */

/** A token is just its symbol here; NEAR Intents picks the chain when it buys. */
const keyOf = (t: { symbol: string }) => t.symbol.toUpperCase();

/**
 * A jar built by hand, without the agent: pick the tokens here, then "How much?" (the
 * split's − / + and the amount) and the launch, thesis-new's as for any jar.
 */
export default function BuildJarScreen() {
  const styles = useStyles();
  const c = useTheme();
  const market = useMarketList();
  // One row per symbol (USDC on three chains is one USDC), the most liquid listing first.
  const list = useMemo(() => uniqueBySymbol(market), [market]);
  // Rows wait behind a skeleton until the list and its top tokens' numbers are in, then
  // keep the order they first settled in: late prices fill in rows, never reshuffle them.
  const settled = useMarketSettled(list);
  const order = useRef<Map<string, number> | null>(null);
  if (settled && !order.current && list.length)
    order.current = new Map(
      [...list].sort((a, b) => b.volume - a.volume).map((t, i) => [keyOf(t), i]),
    );
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<MarketToken[]>([]);
  const insets = useSafeAreaInsets();
  const [limit, setLimit] = useState(SHOWN);

  const q = query.trim().toLowerCase();
  // A new search starts from the first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the search changes.
  useEffect(() => setLimit(SHOWN), [q]);
  // Search's Top tokens, in its order (most traded first), drawn a page at a time as
  // you scroll, so the list never ends until the tokens do.
  const matches = list
    .filter((t) => !isDollar(t) && matchesQuery(t, q))
    .sort((a, b) => {
      const rank = order.current;
      const ra = rank?.get(keyOf(a)) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank?.get(keyOf(b)) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb || b.volume - a.volume;
    });
  const tokens = matches.slice(0, limit);
  const more = matches.length > tokens.length;
  const isPicked = (t: MarketToken) => picked.some((p) => keyOf(p) === keyOf(t));
  const toggle = (t: MarketToken) => {
    tap();
    setPicked((prev) =>
      prev.some((p) => keyOf(p) === keyOf(t))
        ? prev.filter((p) => keyOf(p) !== keyOf(t))
        : prev.length >= MAX_PICKS
          ? prev
          : [...prev, t],
    );
  };

  return (
    <PushedScreen
      title="Build your own"
      fallback="/jars"
      onEndReached={more ? () => setLimit((n) => n + SHOWN) : undefined}
      footer={
        // Rides above the keyboard while searching, so Continue is never covered.
        <KeyboardFooter under={insets.bottom + SCREEN.footerBottom} style={styles.flex}>
          <PillButton
            label={
              picked.length
                ? `Continue with ${picked.length} ${picked.length === 1 ? 'token' : 'tokens'}`
                : 'Pick at least one token'
            }
            disabled={!picked.length}
            onPress={() => {
              tap();
              // "How much?" (thesis-new) reads the picks from the draft, then sizes them.
              chatDraft.set(manualProposal(picked, 0));
              router.push({ pathname: '/thesis-new', params: { step: 'proposal', manual: '1' } });
            }}
          />
        </KeyboardFooter>
      }
    >
      <Sticky id="jar-build-search">
        <View style={styles.top}>
          <SearchField value={query} onChangeText={setQuery} placeholder="Search tokens" />
          {picked.length ? (
            <View style={styles.pickedRow}>
              {picked.map((t) => (
                <Chip
                  key={keyOf(t)}
                  label={t.symbol}
                  selected
                  leading={<TokenIcon symbol={t.symbol} size={20} uri={t.logo} />}
                  accessibilityLabel={`Remove ${t.symbol}`}
                  onPress={() => toggle(t)}
                />
              ))}
            </View>
          ) : (
            <Text style={styles.hint}>Pick up to {MAX_PICKS} tokens. You set the split next.</Text>
          )}
        </View>
      </Sticky>
      <View style={styles.gutter}>
        {!settled ? (
          // The Top tokens skeleton: logo, two lines, price and change.
          Array.from({ length: 9 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
            <View key={i} style={styles.row}>
              <SkeletonBar width={40} height={40} radius={20} />
              <View style={[styles.flex, styles.skeletonLines]}>
                <SkeletonBar width="50%" height={14} />
                <SkeletonBar width="32%" height={12} />
              </View>
              <View style={styles.end}>
                <SkeletonBar width={68} height={14} />
                <SkeletonBar width={44} height={12} />
              </View>
            </View>
          ))
        ) : tokens.length ? null : (
          <Text style={styles.hint}>No tokens match</Text>
        )}
        {(settled ? tokens : []).map((item) => {
          const on = isPicked(item);
          const full = !on && picked.length >= MAX_PICKS;
          return (
            <PressableRow
              key={keyOf(item)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled: full }}
              disabled={full}
              onPress={() => toggle(item)}
              style={[styles.row, full && styles.off]}
            >
              {/* Search's Top tokens row: logo, name and volume, price and the day's move. */}
              <TokenIcon symbol={item.symbol} size={40} uri={item.logo} />
              <View style={styles.flex}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {item.volume ? `${formatCompactUsd(item.volume)} Vol` : item.symbol}
                </Text>
              </View>
              {item.price ? (
                <View style={styles.end}>
                  <Text style={styles.name}>{formatPrice(item.price)}</Text>
                  <Change value={item.change} />
                </View>
              ) : null}
              <View style={[styles.check, on && styles.checkOn]}>
                {on ? <Icon name="check" size={13} color={c.onPrimary} /> : null}
              </View>
            </PressableRow>
          );
        })}
      </View>
    </PushedScreen>
  );
}

const useStyles = makeStyles((c) => ({
  flex: {
    flex: 1,
  },
  top: {
    paddingHorizontal: SCREEN.gutter,
    paddingBottom: 8,
    backgroundColor: c.canvas,
  },
  gutter: {
    paddingHorizontal: SCREEN.gutter,
  },
  pickedRow: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  hint: {
    marginTop: 12,
    color: c.textSecondary,
    fontSize: 15,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  off: {
    opacity: 0.4,
  },
  end: {
    alignItems: 'flex-end',
    gap: 2,
  },
  skeletonLines: {
    gap: 6,
  },
  name: {
    color: c.text,
    fontSize: 16,
    fontWeight: '500',
  },
  meta: {
    marginTop: 2,
    color: c.textSecondary,
    fontSize: 14,
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: c.divider,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: {
    borderColor: c.primary,
    backgroundColor: c.primary,
  },
}));
