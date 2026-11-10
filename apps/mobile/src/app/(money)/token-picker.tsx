import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { TokenList } from '@/components/home/TokenList';
import { Icon } from '@/components/Icon';
import { PressableScale } from '@/components/motion/PressableScale';
import { closeSheet, SheetHeader, SheetRow, SheetScreen } from '@/components/sheets/Sheet';
import { NetworkGrid, TokenIcon } from '@/components/wallet/parts';
import { SearchField } from '@/components/wallet/SearchField';
import { tap } from '@/lib/haptics';
import { SWAP_TOKENS } from '@/lib/intents-swap';
import { CHAINS, formatBalance, tokenName } from '@/lib/mock-wallet';
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

  // Real swaps list only the tokens NEAR Intents can swap from and to this wallet.
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

/** The tokens a real swap supports, with what you hold of each. */
function LiveTokens({
  side,
  onChoose,
}: {
  side: 'sell' | 'buy';
  onChoose: (token: TokenRef) => void;
}) {
  const c = useTheme();
  const view = useWalletView();
  const holdings = 'holdings' in view ? (view.holdings ?? []) : [];
  const picked = useSwap()[side];
  return (
    <SheetScreen scroll>
      <SheetHeader title={side === 'sell' ? 'Swap from' : 'Swap to'} />
      {SWAP_TOKENS.map((t) => {
        const held = holdings.find((h) => h.symbol === t.symbol && h.chain === t.chain);
        return (
          <SheetRow
            key={`${t.symbol}-${t.chain}`}
            leading={<TokenIcon symbol={t.symbol} chain={t.chain} size={36} ring={c.sheet} />}
            title={`${t.symbol} on ${t.chain}`}
            subtitle={tokenName(t.symbol)}
            value={held ? `${formatBalance(held.amount)} ${t.symbol}` : undefined}
            accessory="check"
            selected={picked.symbol === t.symbol && picked.chain === t.chain}
            onPress={() => onChoose(t)}
          />
        );
      })}
    </SheetScreen>
  );
}

const useStyles = makeStyles(() => ({
  search: {
    marginBottom: 12,
  },
  networkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
}));
