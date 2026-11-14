import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { TokenList } from '@/components/home/TokenList';
import { Icon, type IconName } from '@/components/Icon';
import { PressableRow } from '@/components/motion/PressableRow';
import { PressableScale } from '@/components/motion/PressableScale';
import {
  closeSheet,
  SHEET,
  SheetHeader,
  SheetRow,
  SheetRowSkeletons,
  SheetScreen,
} from '@/components/sheets/Sheet';
import { EmptyState, NetworkGrid, TokenIcon } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { dexTokenList, loadDexTokens } from '@/lib/dex';
import { dexPickerEntries } from '@/lib/dex-tokens';
import { useMoney } from '@/lib/fx';
import { tap } from '@/lib/haptics';
import {
  canSell,
  chainName,
  FALLBACK_SWAP_TOKENS,
  loadSwapTokens,
  type OneClickToken,
  sameToken,
  swapTokenList,
  tokenRef,
} from '@/lib/intents-swap';
import { PAY_CHAINS } from '@/lib/jar-buy';
import { useMarketList } from '@/lib/market';
import { CHAINS, chainSymbol, formatBalance, HOLDINGS, tokenName } from '@/lib/mock-wallet';
import { isUsdc, jarPayWith, jarPayWithChosen } from '@/lib/pay-with';
import { pickToken, type TokenRef, useSwap } from '@/lib/swap';
import { TEST_MODE } from '@/lib/test-mode';
import {
  clearRecentPicks,
  coinName,
  onSupportedNetworks,
  pickerLists,
  quickPicks,
  recentPicks,
  rememberPick,
  shortAddress,
  tokenCategory,
} from '@/lib/token-picker';
import { useWalletView } from '@/lib/wallet-view';
import { makeStyles, useTheme } from '@/theme';

/** Token picker for Swap: search with a network filter over the token list. */
export default function TokenPickerSheet() {
  const styles = useStyles();
  const c = useTheme();
  const {
    side = 'sell',
    live,
    for: target,
  } = useLocalSearchParams<{ side?: 'sell' | 'buy'; live?: string; for?: string }>();
  const { network } = useSwap();
  const [query, setQuery] = useState('');
  // A jar's "Pay with" (JarAmount): what you hold and can pay with; USDC means any network.
  const jar = target === 'jar';

  const choose = (token: TokenRef) => {
    tap();
    if (jar) {
      jarPayWith.set(isUsdc(token) ? null : token);
      // Picked by hand: it stays, whatever the wallet holds (lib/pay-with).
      jarPayWithChosen.set(true);
    } else pickToken(side, token);
    closeSheet();
  };

  // Real swaps list every token NEAR Intents trades (to sell: the ones this wallet can pay).
  if (live === '1' || jar)
    return <LiveTokens side={jar ? 'sell' : side} jar={jar} onChoose={choose} />;

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

/* Uniswap's flat list replaced the per-network groups (14 Nov), so these went with them.
const PER_CHAIN = 6;
*/
/** Rows per page of the token list and of search results. */
const PAGE = 40;
/** Logo size in the rows, as Uniswap's. */
const ICON = 40;

/**
 * Every token NEAR Intents trades (plus Honey's DEX tokens), laid out like Uniswap's iOS
 * token selector: search with Paste and a network selector, quick-pick chips, "Your
 * tokens", "Recent searches", then every token as one list. Selling lists only what this
 * wallet can pay; buying lists everything. A jar's "Pay with" lists only what you hold.
 */
function LiveTokens({
  side,
  jar = false,
  onChoose,
}: {
  side: 'sell' | 'buy';
  /** Paying for a jar: only what you hold and can pay with, USDC as one row. */
  jar?: boolean;
  onChoose: (token: TokenRef) => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  const money = useMoney();
  const view = useWalletView();
  // Test mode's sample wallets hold the sample portfolio here too, so the lists fill in.
  const holdings: {
    symbol: string;
    chain: string;
    amount: number;
    usd: number;
    assetId?: string;
  }[] = 'holdings' in view ? (view.holdings ?? []) : TEST_MODE && view.wallet.demo ? HOLDINGS : [];
  const swapState = useSwap();
  // An empty Buy (lib/swap `buyChosen`) has nothing picked to tick.
  const swapPick = side === 'buy' && !swapState.buyChosen ? null : swapState[side];
  const jarPick = jarPayWith.useValue();
  const picked: TokenRef | null = jar ? jarPick : swapPick;
  const recent = recentPicks.useValue();
  // A jar's USDC is paid from whichever networks hold it (lib/jar-buy), so it's one row.
  const usdcHeld = holdings
    .filter((h) => h.symbol === 'USDC' && (PAY_CHAINS as readonly string[]).includes(h.chain))
    .reduce((s, h) => s + h.usd, 0);
  const { tokens: oneClick, failed } = swapTokenList.useValue();
  // Tokens NEAR Intents doesn't list but Honey's DEX route trades on their own chain.
  const { tokens: dex } = dexTokenList.useValue();
  const tokens = oneClick ? [...oneClick, ...dexPickerEntries(dex ?? [], oneClick)] : null;
  const [query, setQuery] = useState('');
  const [chain, setChain] = useState<string | null>(null);
  // The network selector's list of networks, shown in place of the tokens.
  const [choosingNetwork, setChoosingNetwork] = useState(false);
  useEffect(loadSwapTokens, []);
  useEffect(loadDexTokens, []);

  // By asset when the server matched the holding in this list (look-alikes never merge);
  // the chain's own coin, which carries no asset id, by symbol and network.
  const heldOf = (t: OneClickToken) =>
    holdings.find((h) =>
      h.assetId
        ? h.assetId === t.assetId
        : h.symbol === t.symbol && h.chain === chainName(t.blockchain),
    );
  // Market cap order and names from the market list (lib/market), as Search uses.
  const market = useMarketList();
  const marketRank = new Map<string, number>();
  const marketChain = new Map<string, string>();
  const marketName = new Map<string, string>();
  market.forEach((m, i) => {
    const key = m.symbol.toUpperCase();
    marketRank.set(key, i);
    marketChain.set(key, m.chain);
    marketName.set(key, m.name);
    // Wrapped copies folded into a coin's row (WETH under ETH) rank just after it.
    for (const alias of m.aliases ?? [])
      if (!marketRank.has(alias.toUpperCase())) marketRank.set(alias.toUpperCase(), i + 0.5);
  });
  // "Arbitrum ETH", "Base ETH": a coin away from its own network, named as Uniswap does.
  const nameOf = (t: OneClickToken) => {
    const known = tokenName(t.symbol);
    const name =
      t.name ?? (known !== t.symbol ? known : (marketName.get(t.symbol.toUpperCase()) ?? known));
    return coinName(t, name, chainName);
  };
  // const listed = (tokens ?? [])
  // Networks Honey supports only (lib/mock-wallet CHAINS), on both sides.
  const listed = onSupportedNetworks(tokens ?? [])
    .filter((t) => side === 'buy' || canSell(t))
    .filter((t) => !jar || (t.symbol !== 'USDC' && (heldOf(t)?.amount ?? 0) > 0));
  const q = query.trim().toLowerCase();
  const {
    chains,
    yours,
    recent: recents,
    rest,
    results,
  } = pickerLists(listed, {
    query,
    chain,
    heldUsd: (t) => {
      const h = heldOf(t);
      return h && h.amount > 0 ? h.usd : null;
    },
    nameOf,
    networkOf: chainName,
    // A jar pays with what it holds; recent swap picks don't belong there.
    recent: jar ? [] : recent,
    popularity: {
      rankOf: (symbol) => marketRank.get(symbol.toUpperCase()),
      mainNetworkOf: (symbol) => marketChain.get(symbol.toUpperCase()),
    },
  });
  const picks = jar || q ? [] : quickPicks(listed, chain);
  // Long lists show in pages, with "Show more" at the end.
  const [limit, setLimit] = useState(PAGE);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the search or network changes.
  useEffect(() => setLimit(PAGE), [q, chain]);

  const pick = (ref: TokenRef) => {
    if (!jar) rememberPick(ref);
    onChoose(ref);
  };

  /**
   * One token, as Uniswap's row: logo with its network's badge, the full name over the
   * symbol and a short contract; on the right what you hold, or (`tag`) its kind.
   */
  const row = (t: OneClickToken, key: string, right: 'value' | 'tag' | 'none') => {
    const ref = tokenRef(t);
    const held = heldOf(t);
    const own = !!held && held.amount > 0;
    const category = tokenCategory(t.symbol);
    return (
      <TokenRow
        key={`${key}-${t.assetId}`}
        icon={
          <TokenIcon symbol={t.symbol} chain={chainName(t.blockchain)} size={ICON} ring={c.sheet} />
        }
        title={nameOf(t)}
        symbol={t.symbol}
        detail={shortAddress(t.contractAddress)}
        value={right !== 'none' && own ? money.format(held.usd) : undefined}
        amount={right !== 'none' && own ? formatBalance(held.amount) : undefined}
        tag={right === 'tag' && !own && category ? category : undefined}
        selected={!!picked && sameToken(picked, ref)}
        onPress={() => pick(ref)}
      />
    );
  };
  /* The chain is shown only by the logo's badge now (14 Nov, Uniswap's rows), so the
  subtitles naming it ("Tether USD · Ethereum", "… · to an address you enter") went.
  subtitle={
    side === 'buy' && needsRecipient(t.blockchain)
      ? `${name} · to an address you enter`
      : [tokenName(t.symbol), name]
          .filter((x, i, all) => x !== t.symbol && all.indexOf(x) === i)
          .join(' · ')
  }
  */
  const usdcRow =
    jar && usdcHeld > 0 && !chain && (!q || 'usdc'.includes(q) || 'usd coin'.includes(q)) ? (
      <TokenRow
        key="usdc"
        icon={<TokenIcon symbol="USDC" size={ICON} ring={c.sheet} />}
        title="USD Coin"
        symbol="USDC"
        detail="Any network"
        value={money.format(usdcHeld)}
        selected={!picked}
        onPress={() => onChoose({ symbol: 'USDC', chain: 'Base' })}
      />
    ) : null;

  const networkSelector = (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Network: ${chain ? chainName(chain) : 'All networks'}`}
      accessibilityState={{ expanded: choosingNetwork }}
      hitSlop={8}
      scaleTo={0.97}
      onPress={() => {
        tap();
        setChoosingNetwork((open) => !open);
      }}
      style={styles.networkButton}
    >
      {chain ? (
        <TokenIcon symbol={chainSymbol(chainName(chain))} size={20} />
      ) : (
        <NetworkGrid size={20} />
      )}
      <Icon name="chevronDown" size={12} color={c.textSecondary} />
    </PressableScale>
  );
  const sticky = (
    <SearchField
      value={query}
      onChangeText={setQuery}
      placeholder="Search tokens"
      style={styles.searchField}
      trailing={
        <View style={styles.trailing}>
          {query ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              hitSlop={13}
              scaleTo={0.9}
              onPress={() => {
                tap();
                setQuery('');
              }}
              style={styles.clear}
            >
              <Icon name="close" size={10} color={c.sheet} />
            </PressableScale>
          ) : (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Paste a token address"
              hitSlop={8}
              scaleTo={0.97}
              onPress={() => {
                tap();
                void Clipboard.getStringAsync().then((text) => {
                  if (text.trim()) setQuery(text.trim());
                });
              }}
              style={styles.paste}
            >
              <Icon name="paste" size={14} color={c.textSecondary} />
              <Text style={styles.pasteLabel}>Paste</Text>
            </PressableScale>
          )}
          {chains.length > 1 ? networkSelector : null}
        </View>
      }
    />
  );
  /* Uniswap keeps the networks in the search field's selector (14 Nov, the user's call),
  so the row of network chips under the search went.
      {chains.length > 1 && (
        <ScrollView horizontal …>
          <Chip label="All" leading={<NetworkGrid size={18} />} … />
          {chains.map((code) => <Chip key={code} label={chainName(code)} … />)}
        </ScrollView>
      )}
  */

  if (!tokens)
    return (
      <SheetScreen scroll>
        {jar ? <SheetHeader title="Pay with" /> : null}
        {failed && jar ? (
          usdcRow
        ) : failed ? (
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
                selected={!!picked && sameToken(picked, t)}
                onPress={() => pick(t)}
              />
            ))}
          </>
        ) : (
          <SheetRowSkeletons count={7} icon={36} />
        )}
      </SheetScreen>
    );

  if (choosingNetwork)
    return (
      <SheetScreen scroll sticky={sticky}>
        {jar ? <SheetHeader title="Pay with" /> : null}
        {[null, ...chains].map((code) => (
          <SheetRow
            key={code ?? 'all'}
            leading={
              code ? (
                <TokenIcon symbol={chainSymbol(chainName(code))} size={28} />
              ) : (
                <NetworkGrid size={28} />
              )
            }
            title={code ? chainName(code) : 'All networks'}
            accessory="check"
            selected={chain === code}
            onPress={() => {
              tap();
              setChain(code);
              setChoosingNetwork(false);
            }}
          />
        ))}
      </SheetScreen>
    );

  const more = (total: number) =>
    total > limit ? (
      <SheetRow
        icon="chevronDown"
        title={`Show ${Math.min(PAGE, total - limit)} more`}
        onPress={() => {
          tap();
          setLimit((n) => n + PAGE);
        }}
      />
    ) : null;

  return (
    <SheetScreen scroll sticky={sticky}>
      {/* Swap's picker opens straight on the list (14 Nov): no "Swap from" title or intro.
      <SheetHeader title={jar ? 'Pay with' : side === 'sell' ? 'Swap from' : 'Swap to'} />
      {side === 'sell' && !jar && !q && !chain && (
        <Text style={styles.note}>
          You can sell tokens on Ethereum, Base, Arbitrum, Polygon, Solana and NEAR, and get any of{' '}
          {listed.length} tokens on {chains.length} networks.
        </Text>
      )}
      */}
      {jar ? <SheetHeader title="Pay with" /> : null}
      {picks.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={styles.chipScroll}
          contentContainerStyle={styles.chips}
        >
          {/* Uniswap's quick picks: a tighter pill with a bold symbol than Honey's Chip. */}
          {picks.map((t) => (
            <PressableScale
              key={t.assetId}
              accessibilityRole="button"
              accessibilityLabel={`${nameOf(t)}, ${t.symbol}`}
              scaleTo={0.97}
              onPress={() => {
                tap();
                pick(tokenRef(t));
              }}
              style={styles.quick}
            >
              <TokenIcon
                symbol={t.symbol}
                chain={chainName(t.blockchain)}
                size={24}
                ring={c.sheet}
              />
              <Text style={styles.quickLabel}>{t.symbol}</Text>
            </PressableScale>
          ))}
        </ScrollView>
      )}
      {(yours.length > 0 || usdcRow) && <PickerSection icon="coins" title="Your tokens" />}
      {usdcRow}
      {(jar ? yours.slice(0, limit) : yours).map((t) => row(t, 'yours', 'value'))}
      {jar ? more(yours.length) : null}
      {recents.length > 0 && (
        <PickerSection
          icon="clockFill"
          title="Recent searches"
          action={{
            label: 'Clear',
            onPress: () => {
              tap();
              clearRecentPicks();
            },
          }}
        />
      )}
      {recents.map((t) => row(t, 'recent', 'none'))}
      {/* Uniswap's "Tokens by 24H volume": we have no volume, so it's just "Tokens". */}
      {!jar && rest.length > 0 && <PickerSection icon="trending" title="Tokens" />}
      {!jar && rest.slice(0, limit).map((t) => row(t, 'all', 'tag'))}
      {!jar && more(rest.length)}
      {results.slice(0, limit).map((t) => row(t, 'result', 'tag'))}
      {more(results.length)}
      {jar && !usdcRow && yours.length === 0 && !q && (
        <EmptyState
          icon="wallet"
          title="Nothing to pay with"
          hint="Add money to this wallet first."
        />
      )}
      {(q ? results.length === 0 : rest.length === 0) && (jar ? !!q && !usdcRow : true) && (
        <EmptyState
          icon="search"
          title="No tokens found"
          hint="Try another name, symbol or address."
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

/* One network's tokens with "More on …": Uniswap's flat list replaced the per-network
groups (14 Nov).
function ChainGroup({ name, count, capped, onMore, children }) {
  return (
    <>
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
*/

/** A section's label with its small icon, as Uniswap's ("Your tokens", "Recent searches"). */
function PickerSection({
  icon,
  title,
  action,
}: {
  icon: IconName;
  title: string;
  action?: { label: string; onPress: () => void };
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <View style={styles.section}>
      <Icon name={icon} size={14} color={c.textSecondary} />
      <Text style={styles.sectionLabel} accessibilityRole="header">
        {title}
      </Text>
      {action ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`${action.label} ${title.toLowerCase()}`}
          hitSlop={10}
          scaleTo={0.97}
          onPress={action.onPress}
        >
          <Text style={styles.sectionAction}>{action.label}</Text>
        </PressableScale>
      ) : null}
    </View>
  );
}

/**
 * A token row, as Uniswap's: logo, full name over "SYMBOL 0xA0b8…eB48", then what you hold
 * (value over amount) or an outlined tag on the right, and a check on the current pick.
 */
function TokenRow({
  icon,
  title,
  symbol,
  detail,
  value,
  amount,
  tag,
  selected,
  onPress,
}: {
  icon: ReactNode;
  title: string;
  symbol: string;
  /** Muted, after the symbol: the short contract (none for a chain's own coin). */
  detail?: string;
  value?: string;
  amount?: string;
  tag?: string;
  selected: boolean;
  onPress: () => void;
}) {
  const styles = useStyles();
  const c = useTheme();
  return (
    <PressableRow
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={[title, symbol, value, amount && `${amount} ${symbol}`]
        .filter(Boolean)
        .join(', ')}
      onPress={onPress}
      style={styles.row}
    >
      {icon}
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {symbol}
          {detail ? <Text style={styles.rowAddress}>{`  ${detail}`}</Text> : null}
        </Text>
      </View>
      {value ? (
        <View style={styles.rowEnd}>
          <Text style={styles.rowValue}>{value}</Text>
          {amount ? <Text style={styles.rowAmount}>{amount}</Text> : null}
        </View>
      ) : tag ? (
        <View style={styles.tag}>
          <Text style={styles.tagLabel}>{tag}</Text>
        </View>
      ) : null}
      {selected ? <Icon name="check" size={18} color={c.accentText} /> : null}
    </PressableRow>
  );
}

const useStyles = makeStyles((c) => ({
  search: {
    marginBottom: 12,
  },
  // Uniswap's field: Honey's height, with softer corners.
  searchField: {
    borderRadius: 16,
    marginBottom: 8,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  paste: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  pasteLabel: {
    color: c.textSecondary,
    fontSize: 15,
    fontWeight: '500',
  },
  clear: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.placeholder,
  },
  chipScroll: {
    marginHorizontal: -SHEET.gutter,
    marginTop: 4,
    marginBottom: 4,
  },
  chips: {
    gap: 9,
    paddingHorizontal: SHEET.gutter,
  },
  // Uniswap's quick pick: logo and bold symbol in a tight outlined pill.
  quick: {
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 4,
    paddingRight: 12,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: c.divider,
  },
  quickLabel: {
    color: c.text,
    fontSize: 17,
    fontWeight: '700',
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
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
    marginBottom: 2,
  },
  sectionLabel: {
    flex: 1,
    color: c.textSecondary,
    fontSize: 16,
  },
  sectionAction: {
    color: c.textSecondary,
    fontSize: 16,
    fontWeight: '500',
  },
  row: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 9,
    // Bleed past the gutter so the press highlight runs edge to edge.
    marginHorizontal: -SHEET.gutter,
    paddingHorizontal: SHEET.gutter,
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    color: c.text,
    fontSize: 18,
    fontWeight: '500',
  },
  rowSubtitle: {
    marginTop: 1,
    color: c.textSecondary,
    fontSize: 15,
  },
  rowAddress: {
    color: c.placeholder,
  },
  rowEnd: {
    alignItems: 'flex-end',
    gap: 2,
  },
  rowValue: {
    color: c.text,
    fontSize: 18,
    fontWeight: '600',
  },
  rowAmount: {
    color: c.textSecondary,
    fontSize: 15,
  },
  // Uniswap's category tag: a compact outlined pill.
  tag: {
    height: 22,
    justifyContent: 'center',
    paddingHorizontal: 7,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: c.divider,
  },
  tagLabel: {
    color: c.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
}));
