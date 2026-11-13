import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { Sticky } from '@/components/motion/Sticky';
import { PillButton } from '@/components/onboarding/PillButton';
import { KeyboardFooter } from '@/components/sheets/KeyboardFooter';
import { Chip } from '@/components/wallet/Chip';
import { PushedScreen, SCREEN, TokenIcon } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { tap } from '@/lib/haptics';
import { uniqueBySymbol, useMarketList } from '@/lib/market';
import type { MarketToken } from '@/lib/mock-wallet';
import { manualProposal } from '@/lib/thesis';
import { chatDraft } from '@/lib/thesis-chat';
import { makeStyles, useTheme } from '@/theme';

/** More than this and a jar stops being a view and becomes an index. */
const MAX_PICKS = 8;
/** Rows drawn before a search narrows them; the list is every token 1Click delivers. */
const SHOWN = 60;
/** Stablecoins aren't a bet; they'd only dilute the jar. */
const SKIP = new Set(['USDC', 'USDT', 'DAI', 'USDE', 'PYUSD']);

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
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<MarketToken[]>([]);
  const insets = useSafeAreaInsets();
  const [limit, setLimit] = useState(SHOWN);

  const q = query.trim().toLowerCase();
  // A new search starts from the first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the search changes.
  useEffect(() => setLimit(SHOWN), [q]);
  const tokens = list
    .filter(
      (t) =>
        !SKIP.has(t.symbol.toUpperCase()) &&
        (!q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)),
    )
    // Searching can still match hundreds: draw a page at a time.
    .slice(0, q ? limit : SHOWN);
  const more = q
    ? list.filter(
        (t) =>
          !SKIP.has(t.symbol.toUpperCase()) &&
          (t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)),
      ).length - tokens.length
    : 0;
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
                  leading={<TokenIcon symbol={t.symbol} size={20} />}
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
        {tokens.length ? null : (
          <Text style={styles.hint}>{list.length ? 'No tokens match' : 'Loading tokens…'}</Text>
        )}
        {tokens.map((item) => {
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
              <TokenIcon symbol={item.symbol} size={36} />
              <View style={styles.flex}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {item.symbol}
                </Text>
              </View>
              <View style={[styles.check, on && styles.checkOn]}>
                {on ? <Icon name="check" size={13} color={c.onPrimary} /> : null}
              </View>
            </PressableRow>
          );
        })}
        {more > 0 ? (
          <PressableRow
            accessibilityRole="button"
            onPress={() => {
              tap();
              setLimit((n) => n + SHOWN);
            }}
            style={styles.row}
          >
            <Icon name="chevronDown" size={14} color={c.textSecondary} />
            <Text style={styles.meta}>Show {Math.min(SHOWN, more)} more</Text>
          </PressableRow>
        ) : null}
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
