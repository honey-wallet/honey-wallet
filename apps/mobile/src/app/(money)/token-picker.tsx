import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useEffect, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { TokenList } from '@/components/home/TokenList';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import {
  closeSheet,
  SheetHeader,
  SheetRow,
  SheetRowSkeletons,
  SheetScreen,
  SheetSection,
} from '@/components/sheets/Sheet';
import { Chip } from '@/components/wallet/Chip';
import { EmptyState, NetworkGrid, TokenIcon } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { tap } from '@/lib/haptics';
import {
  BLOCKCHAINS,
  canSell,
  chainName,
  FALLBACK_SWAP_TOKENS,
  loadSwapTokens,
  needsRecipient,
  type OneClickToken,
  sameToken,
  swapTokenList,
  tokenRef,
} from '@/lib/intents-swap';
import { CHAINS, formatBalance, formatPrice, tokenName } from '@/lib/mock-wallet';
import { pickToken, type TokenRef, useSwap } from '@/lib/swap';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, useTheme } from '@/theme';

/** Token picker for Swap: search with a network filter over the token list. */
export default function TokenPickerSheet() {
  const styles = useStyles();
  const c = useTheme();
  const { side = 'sell', live } = useLocalSearchParams<{ side?: 'sell' | 'buy'; live?: string }>();
  const { network } = useSwap();
  const [query, setQuery] = useState('');

  const choose = (token: TokenRef) => {
    tap();
    pickToken(side, token);
    closeSheet();
  };

  // Real swaps list every token NEAR Intents trades (to sell: the ones this wallet can pay).
  if (live === '1') return <LiveTokens side={side} onChoose={choose} />;

  const search = (
    <SearchField
      value={query}
      onChangeText={setQuery}
      placeholder="Search tokens"
      style={styles.search}
      trailing={
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`Network: ${network ?? 'All networks'}`}
          hitSlop={8}
          scaleTo={0.97}
          onPress={() => {
            tap();
            router.push('/network-picker');
          }}
          style={styles.networkButton}
        >
          {network ? (
            <TokenIcon symbol={CHAINS.find((x) => x.name === network)?.symbol ?? ''} size={20} />
          ) : (
            <NetworkGrid size={20} />
          )}
          <Icon name="chevronDown" size={12} color={c.textSecondary} />
        </PressableScale>
      }
    />
  );

  return (
    <SheetScreen scroll sticky={search}>
      {/* TokenList skeletons itself while balances load. */}
      <TokenList query={query} onChoose={choose} />
    </SheetScreen>
  );
}

/** Rows shown per network before "More on …", when nothing is searched or filtered. */
const PER_CHAIN = 6;
/** Rows per page once searched or filtered to one network. */
const PAGE = 40;
/** Listed first within a network, in this order; the rest alphabetically. */
const FIRST = ['ETH', 'SOL', 'wNEAR', 'BTC', 'USDC', 'USDT', 'WETH', 'WBTC', 'cbBTC'];
const rank = (symbol: string) => {
  const i = FIRST.indexOf(symbol);
  return i === -1 ? FIRST.length : i;
};
const chainOrder = (blockchain: string) => {
  const i = Object.keys(BLOCKCHAINS).indexOf(blockchain);
  return i === -1 ? 999 : i;
};

/**
 * Every token NEAR Intents trades, from its live list: grouped by network with a search
 * and a network filter. Selling lists only what this wallet can pay (its four networks);
 * buying lists everything, on networks without a key here to an address you enter.
 */
function LiveTokens({
  side,
  onChoose,
}: {
  side: 'sell' | 'buy';
  onChoose: (token: TokenRef) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const view = useWalletView();
  const holdings = 'holdings' in view ? (view.holdings ?? []) : [];
  const picked = useSwap()[side];
  const { tokens, failed } = swapTokenList.useValue();
  const [query, setQuery] = useState('');
  const [chain, setChain] = useState<string | null>(null);
  useEffect(loadSwapTokens, []);

  // By asset when the server matched the holding in this list (look-alikes never merge);
  // the chain's own coin, which carries no asset id, by symbol and network.
  const heldOf = (t: OneClickToken) =>
    holdings.find((h) =>
      h.assetId
        ? h.assetId === t.assetId
        : h.symbol === t.symbol && h.chain === chainName(t.blockchain),
    );
  const listed = (tokens ?? [])
    .filter((t) => side === 'buy' || canSell(t))
    .sort(
      (a, b) =>
        chainOrder(a.blockchain) - chainOrder(b.blockchain) ||
        rank(a.symbol) - rank(b.symbol) ||
        a.symbol.localeCompare(b.symbol),
    );
  const chains = [...new Set(listed.map((t) => t.blockchain))];
  const q = query.trim().toLowerCase();
  const matched = listed.filter(
    (t) =>
      (!chain || t.blockchain === chain) &&
      (!q ||
        t.symbol.toLowerCase().includes(q) ||
        chainName(t.blockchain).toLowerCase().includes(q) ||
        tokenName(t.symbol).toLowerCase().includes(q) ||
        t.contractAddress?.toLowerCase() === q),
  );
  // Searching: the token itself before copies of it. "btc" puts Bitcoin's own BTC first,
  // then exact symbols, then natives (no contract), then the rest in network order.
  const relevance = (t: OneClickToken) =>
    (t.symbol.toLowerCase() === q ? 0 : 2) +
    (t.contractAddress ? 1 : 0) +
    (t.symbol.toLowerCase().startsWith(q) ? 0 : 4);
  const shown = q ? [...matched].sort((a, b) => relevance(a) - relevance(b)) : matched;
  const yours = side === 'sell' ? shown.filter((t) => (heldOf(t)?.amount ?? 0) > 0) : [];
  const grouped = new Map<string, OneClickToken[]>();
  for (const t of shown) {
    if (yours.includes(t)) continue;
    grouped.set(t.blockchain, [...(grouped.get(t.blockchain) ?? []), t]);
  }
  const capped = !q && !chain;
  // Searched or filtered lists can run to hundreds of rows: show them in pages.
  const [limit, setLimit] = useState(PAGE);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the search or network changes.
  useEffect(() => setLimit(PAGE), [q, chain]);
  const flat = q ? shown.filter((t) => !yours.includes(t)) : [];

  // "Your tokens" rows show the balance; every other row shows the price, as labelled.
  const row = (t: OneClickToken) => tokenRow(t, false);
  const ownRow = (t: OneClickToken) => tokenRow(t, true);
  const tokenRow = (t: OneClickToken, own: boolean) => {
    const ref = tokenRef(t);
    const held = heldOf(t);
    const name = chainName(t.blockchain);
    return (
      <SheetRow
        key={t.assetId}
        leading={<TokenIcon symbol={t.symbol} chain={name} size={36} ring={c.sheet} />}
        title={t.symbol}
        subtitle={
          side === 'buy' && needsRecipient(t.blockchain)
            ? `${name} · to an address you enter`
            : [tokenName(t.symbol), name]
                .filter((x, i, all) => x !== t.symbol && all.indexOf(x) === i)
                .join(' · ')
        }
        value={
          own && held && held.amount > 0
            ? `${formatBalance(held.amount)} ${t.symbol}`
            : t.price
              ? formatPrice(t.price)
              : undefined
        }
        accessory="check"
        selected={sameToken(picked, ref)}
        onPress={() => onChoose(ref)}
      />
    );
  };

  const sticky = (
    <>
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder="Search tokens or networks"
        style={styles.search}
      />
      {chains.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipScroll}
          contentContainerStyle={styles.chips}
        >
          <Chip
            label="All"
            leading={<NetworkGrid size={18} />}
            selected={chain === null}
            onPress={() => {
              tap();
              setChain(null);
            }}
          />
          {chains.map((code) => (
            <Chip
              key={code}
              label={chainName(code)}
              selected={chain === code}
              onPress={() => {
                tap();
                setChain(chain === code ? null : code);
              }}
            />
          ))}
        </ScrollView>
      )}
    </>
  );

  if (!tokens)
    return (
      <SheetScreen scroll>
        <SheetHeader title={side === 'sell' ? 'Swap from' : 'Swap to'} />
        {failed ? (
          <>
            <Text style={styles.note}>
              Couldn’t reach NEAR Intents for the full list. These always work:
            </Text>
            {FALLBACK_SWAP_TOKENS.map((t) => (
              <SheetRow
                key={`${t.symbol}-${t.chain}`}
                leading={<TokenIcon symbol={t.symbol} chain={t.chain} size={36} ring={c.sheet} />}
                title={`${t.symbol} on ${t.chain}`}
                subtitle={tokenName(t.symbol)}
                accessory="check"
                selected={sameToken(picked, t)}
                onPress={() => onChoose(t)}
              />
            ))}
          </>
        ) : (
          <SheetRowSkeletons count={7} icon={36} />
        )}
      </SheetScreen>
    );

  return (
    <SheetScreen scroll sticky={sticky}>
      <SheetHeader title={side === 'sell' ? 'Swap from' : 'Swap to'} />
      {side === 'sell' && !q && !chain && (
        <Text style={styles.note}>
          You can sell tokens on Ethereum, Base, Arbitrum, Polygon, Solana and NEAR, and get any of{' '}
          {listed.length} tokens on {chains.length} networks.
        </Text>
      )}
      {yours.length > 0 && <SheetSection title="Your tokens · balance" />}
      {yours.map(ownRow)}
      {q ? (
        <>
          {flat.length > 0 && <SheetSection title="Results · price" />}
          {flat.slice(0, limit).map(row)}
          {flat.length > limit && (
            <SheetRow
              icon="chevronDown"
              title={`Show ${Math.min(PAGE, flat.length - limit)} more`}
              onPress={() => {
                tap();
                setLimit((n) => n + PAGE);
              }}
            />
          )}
        </>
      ) : null}
      {(q ? [] : [...grouped.entries()]).map(([code, list]) => (
        <ChainGroup
          key={code}
          name={chainName(code)}
          count={list.length}
          capped={capped && list.length > PER_CHAIN}
          onMore={() => {
            tap();
            setChain(code);
          }}
        >
          {(capped ? list.slice(0, PER_CHAIN) : list.slice(0, limit)).map(row)}
          {!capped && list.length > limit && (
            <SheetRow
              icon="chevronDown"
              title={`Show ${Math.min(PAGE, list.length - limit)} more`}
              onPress={() => {
                tap();
                setLimit((n) => n + PAGE);
              }}
            />
          )}
        </ChainGroup>
      ))}
      {shown.length === 0 && (
        <EmptyState
          icon="search"
          title="No tokens found"
          hint="Try another name or network."
          action={{
            label: 'Clear search',
            onPress: () => {
              setQuery('');
              setChain(null);
            },
          }}
        />
      )}
    </SheetScreen>
  );
}

/** One network's tokens, with "More on …" when the list is cut short. */
function ChainGroup({
  name,
  count,
  capped,
  onMore,
  children,
}: {
  name: string;
  count: number;
  capped: boolean;
  onMore: () => void;
  children: ReactNode;
}) {
  return (
    <>
      {/* The right column is each token's price; balances are under "Your tokens". */}
      <SheetSection title={`${name} · price`} />
      {children}
      {capped && (
        <SheetRow
          icon="chevronDown"
          title={`All ${count} on ${name}`}
          accessibilityLabel={`Show all ${count} tokens on ${name}`}
          onPress={onMore}
        />
      )}
    </>
  );
}

const useStyles = makeStyles((c) => ({
  search: {
    marginBottom: 12,
  },
  chipScroll: {
    marginHorizontal: -20,
    marginBottom: 8,
  },
  chips: {
    gap: 8,
    paddingHorizontal: 20,
  },
  note: {
    marginBottom: 8,
    color: c.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  networkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
}));
